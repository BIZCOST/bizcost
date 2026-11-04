import type {
  CountDto,
  CountReviewDto,
  LocationDto,
  MemberLocationsDto,
  PurchaseDto,
  PurchaseReturnDto,
  RecipeResultDto,
} from '@bizcost/contracts'
import {
  compareDecimal,
  newId,
  roundForDisplay,
  subtractDecimals,
  sumDecimals,
} from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ledgerDrift } from './ledger'
import { tag } from './product-costs'
import { codeOf, line, milkInput, ok, purchaseInput } from './purchasing'
import { Races } from './races'
import { CAFE, CAFE_BRANCHES, shift } from './sales'
import { lineOf, litres, PREVIEW_MODULES, StockApi, StockScope } from './stock'

// The review of M4 Step 2 (counts; D-339, D-343–D-345), as regression tests of what it found:
//   - a purchase or supplier return posted before a first count that stands is not reversed
//     (STOCK_COUNTED): the first count is absolute in the cost engine and relative in its rows, so
//     the cost row and the balances would part; posted after it, whatever its day, it reverses;
//   - a first count is not started or finalized while a removed branch holds stock of one of its
//     materials (BRANCH_HAS_STOCK), nor reversed while stock was taken out since (STOCK_USED_SINCE);
//   - the two projections agree (ledgerDrift: the cost row's quantity is the balances added) through
//     branches, counts and reversals;
//   - Q3: a product costs the same the day before and after a first count, to the currency's cent;
//   - who sees a finalized count's difference (Q6, Q16): whoever sees stock sees the stock card;
//   - a manager finalizes what they reviewed: every line change moves the count's version on, and
//     two counters saving different lines at once never conflict;
//   - count.review is for drafts; count.start is idempotent before any check; a first count is read
//     only with a line in one of the reader's branches; a count's reversal locks every material's
//     cost row.

let api: StockApi

beforeAll(() => {
  api = new StockApi()
})

afterAll(async () => {
  await api?.close()
})

async function cafe(answers = CAFE) {
  const scope = await StockScope.open(api, answers)
  const milk = await scope.material(milkInput().input)
  return { scope, milk, today: await scope.today() }
}

/** What the material's balances add up to (every branch), read as postgres. */
async function balancesOf(scope: StockScope, materialId: string): Promise<string> {
  const rows = await api.admin<{ qty: string }[]>`
    select trim_scale(qty)::text as qty from app.stock_balances
     where business_id = ${scope.id} and material_id = ${materialId}`
  return sumDecimals(rows.map((r) => r.qty))
}

async function expectNoDrift(scope: StockScope, step?: string) {
  expect(await ledgerDrift(api.admin, scope.id), step).toEqual([])
}

/** A supplier return (`qty` litres of the purchase's first line) or credit note, posted. */
async function giveBack(
  scope: StockScope,
  purchase: PurchaseDto,
  date: string,
  part: { qty: string } | { amount: string },
): Promise<PurchaseReturnDto> {
  return scope.postReturn(
    await scope.returnDraft({
      id: newId(),
      purchaseId: purchase.id,
      kind: 'qty' in part ? 'return' : 'credit_note',
      businessDate: date,
      lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, ...part }],
    }),
  )
}

describe('a first count and what was posted before it (STOCK_COUNTED)', () => {
  it('a purchase posted before a first count that stands is not reversed; the cost row and the balances agree', async () => {
    const { scope, milk, today } = await cafe()
    const bought = await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '12', '6')]))
    const opening = await scope.opening(shift(today, -2), [milk.id], () => litres('40'))
    expect(await scope.costRow(milk.id)).toMatchObject({ qty: '40000', value: '240' })
    expect(await balancesOf(scope, milk.id)).toBe('40000')

    // The first count set the milk to 40 L: taking last week's purchase out would leave the cost row
    // at 40 L and the shelf at 28 L.
    for (const [path, input] of [
      ['purchase.reverse', { id: bought.id }],
      ['purchase.correct', { id: bought.id, newId: newId() }],
    ] as const) {
      const refused = await scope.run(path, input)
      expect(codeOf(refused), path).toBe('stock_counted')
      expect(refused.error?.data.names, path).toEqual([milk.name])
    }
    const item = (await scope.stock()).data.items[0]!
    expect({
      cost: (await scope.costRow(milk.id))?.qty,
      balances: await balancesOf(scope, milk.id),
      listed: item.onHand,
      value: item.value,
    }).toEqual({ cost: '40000', balances: '40000', listed: '40000', value: '240' })
    await expectNoDrift(scope)

    // With the first count reversed first, the purchase is: nothing is left.
    await scope.reverseCount(opening.id)
    expect((await scope.reverse(bought.id)).status).toBe('reversed')
    expect(await scope.costRow(milk.id)).toMatchObject({ qty: '0', value: '0' })
    expect(await balancesOf(scope, milk.id)).toBe('0')
    await expectNoDrift(scope)
  })

  it('a later count of what is on the shelf finds no difference (no gain from a purchase taken out)', async () => {
    const { scope, milk, today } = await cafe()
    const bought = await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '12', '6')]))
    await scope.opening(shift(today, -2), [milk.id], () => litres('40'))
    expect(codeOf(await scope.run('purchase.reverse', { id: bought.id }))).toBe('stock_counted')
    const count = await scope.start({ kind: 'count', businessDate: today, materialIds: 'all' })
    await scope.save(count, milk.id, litres('40'))
    const done = await scope.finalize(await scope.count(count.id))
    expect({
      book: lineOf(done, milk.id).bookQty,
      difference: lineOf(done, milk.id).differenceQty,
      cost: await scope.costRow(milk.id),
      balances: await balancesOf(scope, milk.id),
    }).toEqual({
      book: '40000',
      difference: '0',
      cost: { qty: '40000', value: '240', avg_cost: '0.006' },
      balances: '40000',
    })
    await expectNoDrift(scope)
  })

  it('a purchase dated before the first count but posted after it reverses: it comes after it in the ledger', async () => {
    const { scope, milk, today } = await cafe()
    await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '12', '6')]))
    await scope.opening(shift(today, -2), [milk.id], () => litres('40'))
    const late = await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '5', '7')]))
    expect(await scope.costRow(milk.id)).toMatchObject({ qty: '45000', value: '275' })
    expect((await scope.reverse(late.id)).status).toBe('reversed')
    expect(await scope.costRow(milk.id)).toMatchObject({ qty: '40000', value: '240' })
    expect(await balancesOf(scope, milk.id)).toBe('40000')
    await expectNoDrift(scope)
  })

  it('a supplier return posted before it is not reversed; a credit note (no quantity) is', async () => {
    const { scope, milk, today } = await cafe()
    const bought = await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '12', '6')]))
    const returned = await giveBack(scope, bought, shift(today, -3), { qty: '2' })
    const credited = await giveBack(scope, bought, shift(today, -3), { amount: '6' })
    await scope.opening(shift(today, -2), [milk.id], () => litres('40'))
    const refused = await scope.run('purchaseReturn.reverse', { id: returned.id })
    expect(codeOf(refused)).toBe('stock_counted')
    expect(refused.error?.data.names).toEqual([milk.name])
    // The first count's value (40 L at that day's average, the return and the credit taken off: 54 ÷
    // 10 L) stays: what came before it is not in the stock it set.
    expect(await scope.costRow(milk.id)).toEqual({ qty: '40000', value: '216', avg_cost: '0.0054' })
    ok(await scope.run('purchaseReturn.reverse', { id: credited.id }))
    expect(await scope.costRow(milk.id)).toEqual({ qty: '40000', value: '216', avg_cost: '0.0054' })
    expect(await balancesOf(scope, milk.id)).toBe('40000')
    await expectNoDrift(scope)
  })
})

describe('a first count while a removed branch holds stock (BRANCH_HAS_STOCK)', () => {
  it('is neither started nor finalized: the branch’s stock would stay out of what the count sets', async () => {
    const { scope, milk, today } = await cafe(CAFE_BRANCHES)
    const marina = ok(
      await scope.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    await scope.buy(
      purchaseInput(shift(today, -3), [line(milk.id, '5', '6')], { locationId: marina.id }),
    )
    // Started while Marina was there; its line taken off, then Marina removed with 5 L in it.
    const draft = await scope.start({
      kind: 'opening',
      businessDate: shift(today, -1),
      materialIds: [milk.id],
    })
    expect(draft.lines).toHaveLength(2)
    const there = lineOf(draft, milk.id, marina.id)
    ok(
      await scope.run('count.removeLine', {
        countId: draft.id,
        lineId: there.id,
        version: there.version,
      }),
    )
    ok(await scope.run('location.remove', { id: marina.id }))
    let read = await scope.count(draft.id)
    await scope.save(read, milk.id, litres('12'))
    read = await scope.count(draft.id)
    const finalized = await scope.run('count.finalize', { id: read.id, version: read.version })
    expect(codeOf(finalized)).toBe('branch_has_stock')
    expect(finalized.error?.data).toMatchObject({ names: [marina.name], materials: [milk.name] })
    const started = await scope.run('count.start', {
      id: newId(),
      kind: 'opening',
      businessDate: today,
      materialIds: [milk.id],
    })
    expect(codeOf(started)).toBe('branch_has_stock')
    expect(started.error?.data).toMatchObject({ names: [marina.name], materials: [milk.name] })
    await expectNoDrift(scope)
  })
})

describe('a first count reversed only while nothing took stock out since (STOCK_USED_SINCE)', () => {
  it('a supplier return posted after it stands: reversed first, then the first count is', async () => {
    const { scope, milk, today } = await cafe()
    const bought = await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '12', '6')]))
    const opening = await scope.opening(shift(today, -2), [milk.id], () => litres('40'))
    const returned = await giveBack(scope, bought, today, { qty: '2' })
    const refused = await scope.run('count.reverse', { id: opening.id })
    expect(codeOf(refused)).toBe('stock_used_since')
    expect(refused.error?.data.names).toEqual([milk.name])
    // Posted after the first count, the return reverses as anything else.
    ok(await scope.run('purchaseReturn.reverse', { id: returned.id }))
    expect((await scope.reverseCount(opening.id)).status).toBe('reversed')
    expect(await scope.costRow(milk.id)).toMatchObject({ qty: '12000', value: '72' })
    await expectNoDrift(scope)
  })
})

describe('three branches, two materials, counts and reversals', () => {
  it('the ledger rebuilds and the two projections agree after every step', async () => {
    const { scope, milk, today } = await cafe(CAFE_BRANCHES)
    const sugar = await scope.material(milkInput(`Sugar ${tag()}`).input)
    for (const name of ['Marina', 'Mall']) {
      ok(await scope.run<LocationDto>('location.create', { id: newId(), name: `${name} ${tag()}` }))
    }
    const check = async (step: string) => {
      await expectNoDrift(scope, step)
      for (const m of [milk.id, sugar.id]) {
        const cost = await scope.costRow(m)
        expect(cost?.qty ?? '0', `${step}: ${m}`).toBe(await balancesOf(scope, m))
      }
    }
    await scope.buy(purchaseInput(shift(today, -5), [line(milk.id, '12', '6')]))
    await scope.buy(purchaseInput(shift(today, -5), [line(sugar.id, '3', '3')]))
    await scope.buy(purchaseInput(shift(today, -5), [line(sugar.id, '4', '2')]))
    await check('purchases')
    const opening = await scope.opening(shift(today, -4), [milk.id, sugar.id], (m) =>
      litres(m === milk.id ? '1.5' : '1'),
    )
    expect(opening.lines).toHaveLength(6)
    await check('opening')
    // 3 L of sugar at that day's average of 17 ÷ 7 L: 51 ÷ 7, split over the three branches.
    const sugarRows = await api.admin<{ value: string }[]>`
      select trim_scale(value)::text as value from app.stock_movements
       where business_id = ${scope.id} and material_id = ${sugar.id} and kind = 'opening'`
    expect(sumDecimals(sugarRows.map((r) => r.value))).toBe('7.285714285714')
    await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '5', '7')]))
    await check('purchase after')
    const count = await scope.start({
      kind: 'count',
      businessDate: shift(today, -2),
      materialIds: 'all',
    })
    await scope.save(count, milk.id, litres('4'))
    await scope.save(count, sugar.id, litres('0.5'))
    const done = await scope.finalize(await scope.count(count.id))
    await check('count')
    await scope.reverseCount(done.id)
    await check('count reversed')
    await scope.reverseCount(opening.id)
    await check('opening reversed')
    expect(await scope.costRow(milk.id)).toMatchObject({ qty: '17000', value: '107' })
    await scope.opening(today, [milk.id, sugar.id], () => litres('2'))
    await check('opened again')
  })
})

describe('Q3: a product costs the same the day before and after a first count', () => {
  it('a 200 ml line of milk bought 17 AED for 7 L: the same to the cent, within 0.0000000001', async () => {
    const { scope, milk, today } = await cafe()
    await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '3', '3')]))
    await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '4', '2')]))
    const product = await scope.product({ name: `Latte ${tag()}` })
    const before = await scope.recipe(product.id, [
      { id: newId(), materialId: milk.id, qty: '200', unit: 'ml' },
    ])
    await scope.opening(today, [milk.id], () => litres('7'))
    const after = ok(await scope.run<RecipeResultDto>('recipe.get', { productId: product.id })).data
    const was = before.lines[0]!.cost!.lineCost!
    const is = after.lines[0]!.cost!.lineCost!
    expect(after.lines[0]?.cost?.basis).toBe('stock')
    // Before: 200 × 17 ÷ 7000, rounded once (0.485714285714). After: 200 × the stock average per ml,
    // which is stored at 12 decimals (17 ÷ 7000 → 0.002428571429): 0.4857142858. The stored average
    // is off by at most half its last decimal per base unit, so the line by at most 200 × 0.5e-12;
    // the same to the cent, and the price a screen shows.
    expect(roundForDisplay(is, 2)).toBe(roundForDisplay(was, 2))
    const apart = subtractDecimals(is, was).replace('-', '')
    expect(compareDecimal(apart, '0.0000000001')).toBeLessThanOrEqual(0)
  })
})

describe('who sees a finalized count’s difference (Q6, Q16)', () => {
  it('a member who sees stock (Sales) sees the stock card’s count row, its value only with the costs switch; count.get stays blind', async () => {
    const { scope, milk, today } = await cafe()
    const business = { id: scope.id, owner: scope.owner }
    const [sales, employee] = await Promise.all([
      api.member(business, 'sales'),
      api.member(business, 'employee'),
    ])
    await scope.buy(purchaseInput(shift(today, -2), [line(milk.id, '12', '6')]))
    await scope.opening(shift(today, -1), [milk.id], () => litres('40'))
    const count = await scope.start({ kind: 'count', businessDate: today, materialIds: 'all' })
    await scope.save(count, milk.id, litres('38'))
    await scope.finalize(await scope.count(count.id))

    // count.get: what was counted, never the book or the difference (counts.manage only, D-343).
    const theirs = await scope.count(count.id, sales)
    expect(lineOf(theirs, milk.id).countedQty).toBe('38000')
    expect(lineOf(theirs, milk.id)).not.toHaveProperty('differenceQty')
    expect(lineOf(theirs, milk.id)).not.toHaveProperty('bookQty')
    // The stock card: whoever sees stock sees each entry's quantity and the running quantity, a
    // count's row included (blind counting is for those who count without seeing stock); its value
    // only with the costs switch, which Sales does not have.
    const card = await scope.card({ materialId: milk.id }, sales)
    const row = card.data.entries.find((e) => e.kind === 'count')!
    expect(row).toMatchObject({ qty: '-2000', runningQty: '38000', countedQty: '38000' })
    expect(row).not.toHaveProperty('valueChange')
    expect(row).not.toHaveProperty('unitCost')
    expect(card.meta.redacted).toEqual(
      expect.arrayContaining(['entries.*.valueChange', 'entries.*.unitCost']),
    )
    // The Employee only counts: no stock card, no finalized count.
    expect(codeOf(await scope.as(employee, 'stock.card', { materialId: milk.id }))).toBe(
      'forbidden',
    )
    expect(codeOf(await scope.as(employee, 'count.get', { id: count.id }))).toBe('not_found')
  })
})

describe('a manager finalizes what they reviewed', () => {
  it('a line saved by a counter after the review makes finalize with the reviewed version CONFLICT', async () => {
    const { scope, milk, today } = await cafe()
    const employee = await api.member({ id: scope.id, owner: scope.owner }, 'employee')
    await scope.buy(purchaseInput(shift(today, -2), [line(milk.id, '12', '6')]))
    await scope.opening(shift(today, -1), [milk.id], () => litres('40'))
    const count = await scope.start({ kind: 'count', businessDate: today, materialIds: 'all' })
    await scope.save(count, milk.id, litres('39'))
    const reviewed = await scope.review(count.id)
    expect(reviewed.lines[0]).toMatchObject({ differenceQty: '-1000' })
    expect(reviewed.version).toBeGreaterThan(count.version)
    // A counter changes the line after the manager looked: 10 L instead of 39 L.
    const fresh = await scope.count(count.id, employee)
    await scope.save(fresh, milk.id, litres('10'), employee)
    const result = await scope.run<{ data: CountDto }>('count.finalize', {
      id: count.id,
      version: reviewed.version,
    })
    expect(codeOf(result)).toBe('conflict')
    // Reviewed again, it finalizes what that review showed.
    const again = await scope.review(count.id)
    expect(again.lines[0]).toMatchObject({ differenceQty: '-30000' })
    const done = ok(
      await scope.run<{ data: CountDto }>('count.finalize', {
        id: count.id,
        version: again.version,
      }),
    ).data
    expect(lineOf(done, milk.id)).toMatchObject({ countedQty: '10000', differenceQty: '-30000' })
    await expectNoDrift(scope)
  })

  it('every line change moves the count’s version on: saved, counted again, added, taken off', async () => {
    const { scope, milk, today } = await cafe()
    const sugar = await scope.material(milkInput(`Sugar ${tag()}`).input)
    let count = await scope.start({ kind: 'opening', businessDate: today, materialIds: [milk.id] })
    const versions = [count.version]
    const saved = await scope.save(count, milk.id, litres('3'))
    versions.push((await scope.count(count.id)).version)
    ok(
      await scope.run('count.clearLine', {
        countId: count.id,
        lineId: saved.id,
        version: saved.version,
      }),
    )
    versions.push((await scope.count(count.id)).version)
    count = ok(
      await scope.run<{ data: CountDto }>('count.addLines', {
        countId: count.id,
        materialIds: [sugar.id],
      }),
    ).data
    versions.push(count.version)
    const sugarLine = lineOf(count, sugar.id)
    count = ok(
      await scope.run<{ data: CountDto }>('count.removeLine', {
        countId: count.id,
        lineId: sugarLine.id,
        version: sugarLine.version,
      }),
    ).data
    versions.push(count.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(5)
  })

  it('two counters saving different lines at once never conflict (each waits for the count row)', async () => {
    const { scope, milk, today } = await cafe()
    const business = { id: scope.id, owner: scope.owner }
    const sugar = await scope.material(milkInput(`Sugar ${tag()}`).input)
    const [employee, supervisor] = await Promise.all([
      api.member(business, 'employee'),
      api.member(business, 'supervisor'),
    ])
    const count = await scope.start({
      kind: 'opening',
      businessDate: today,
      materialIds: [milk.id, sugar.id],
    })
    const milkLine = lineOf(count, milk.id)
    const sugarLine = lineOf(count, sugar.id)
    const races = new Races(api.admin, 2, { previewModules: PREVIEW_MODULES })
    try {
      // The count row is held: both saves wait for it, then both go through, one after the other.
      await races.interleaved(
        'two counters',
        (sql) => sql`select id from app.stock_counts where id = ${count.id} for update`,
        [
          (i) =>
            races.call(
              business,
              i,
              'count.saveLine',
              { countId: count.id, lineId: milkLine.id, parts: litres('4'), version: 1 },
              employee,
            ),
          (i) =>
            races.call(
              business,
              i,
              'count.saveLine',
              { countId: count.id, lineId: sugarLine.id, parts: litres('2'), version: 1 },
              supervisor,
            ),
        ],
      )
    } finally {
      await races.close()
    }
    const read = await scope.count(count.id)
    expect(read.lines.map((l) => l.countedQty).sort()).toEqual(['2000', '4000'])
    expect(read.version).toBe(count.version + 2)
  })
})

describe('count.review is for drafts', () => {
  it('a finalized count is DOCUMENT_POSTED; what it found is on its lines (count.get)', async () => {
    const { scope, milk, today } = await cafe()
    await scope.buy(purchaseInput(shift(today, -2), [line(milk.id, '12', '6')]))
    await scope.opening(shift(today, -1), [milk.id], () => litres('40'))
    const count = await scope.start({ kind: 'count', businessDate: today, materialIds: 'all' })
    await scope.save(count, milk.id, litres('38'))
    await scope.finalize(await scope.count(count.id))
    expect(codeOf(await scope.run<CountReviewDto>('count.review', { id: count.id }))).toBe(
      'document_posted',
    )
    expect(lineOf(await scope.count(count.id), milk.id)).toMatchObject({
      bookQty: '40000',
      differenceQty: '-2000',
      differenceValue: '-12',
    })
  })
})

describe('count.start is idempotent before any check (D-031)', () => {
  it('retried with the same id and body after the first count was finalized, it returns that count', async () => {
    const { scope, milk, today } = await cafe()
    const input = { id: newId(), kind: 'opening', businessDate: today, materialIds: [milk.id] }
    const draft = ok(await scope.run<{ data: CountDto }>('count.start', input)).data
    // Another body under the same id is checked as a new start, then CONFLICT (createIdempotent).
    expect(codeOf(await scope.run('count.start', { ...input, note: 'Other' }))).toBe('conflict')
    await scope.save(draft, milk.id, litres('5'))
    await scope.finalize(await scope.count(draft.id))
    // The milk is tracked now (a new start would be STOCK_TRACKED): the retry is not checked again.
    const retried = await scope.run<{ data: CountDto }>('count.start', input)
    expect(codeOf(retried)).toBeUndefined()
    expect(retried.data?.data).toMatchObject({ id: draft.id, status: 'posted' })
  })
})

describe('branch limits (D-234)', () => {
  it('a member limited to a branch cannot read a first count with no line in their branch', async () => {
    const { scope, milk, today } = await cafe(CAFE_BRANCHES)
    // A first count started before Marina existed: one line, in the main branch only.
    const draft = await scope.start({
      kind: 'opening',
      businessDate: today,
      materialIds: [milk.id],
    })
    expect(draft.lines).toHaveLength(1)
    const marina = ok(
      await scope.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    const supervisor = await api.member({ id: scope.id, owner: scope.owner }, 'supervisor')
    const access = ok(
      await scope.run<MemberLocationsDto>('member.locations', { memberId: supervisor.memberId }),
    )
    ok(
      await scope.run('member.updateLocations', {
        memberId: supervisor.memberId,
        version: access.version,
        locationIds: [marina.id],
      }),
    )
    const listed = await scope.counts({}, supervisor)
    expect(listed.items.map((c) => c.id)).not.toContain(draft.id)
    expect(codeOf(await scope.as(supervisor, 'count.get', { id: draft.id }))).toBe('not_found')
  })
})

describe('a count’s reversal locks the cost rows of all its materials', () => {
  it('waits for the cost row of a material whose line found no difference (its later counts are checked under it)', async () => {
    const { scope, milk, today } = await cafe()
    const sugar = await scope.material(milkInput(`Sugar ${tag()}`).input)
    await scope.buy(
      purchaseInput(shift(today, -3), [line(milk.id, '12', '6'), line(sugar.id, '5', '2')]),
    )
    await scope.opening(shift(today, -2), [milk.id, sugar.id], (m) =>
      litres(m === milk.id ? '12' : '5'),
    )
    const count = await scope.start({
      kind: 'count',
      businessDate: shift(today, -1),
      materialIds: 'all',
    })
    await scope.save(count, milk.id, litres('11'))
    await scope.save(count, sugar.id, litres('5'))
    const done = await scope.finalize(await scope.count(count.id))
    expect(lineOf(done, sugar.id).differenceQty).toBe('0')
    const races = new Races(api.admin, 1, { previewModules: PREVIEW_MODULES })
    try {
      // The sugar's cost row is held: the reversal waits for it (no ledger row of the sugar).
      await races.interleaved(
        'reversal waits for every cost row',
        (sql) =>
          sql`select id from app.material_costs
               where business_id = ${scope.id} and material_id = ${sugar.id} for update`,
        [
          (i) =>
            races.call({ id: scope.id, owner: scope.owner }, i, 'count.reverse', { id: done.id }),
        ],
      )
    } finally {
      await races.close()
    }
    expect((await scope.count(done.id)).status).toBe('reversed')
    await expectNoDrift(scope)
  })
})
