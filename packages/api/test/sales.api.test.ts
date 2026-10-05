import type { ProductDto, SaleDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ledgerDrift } from './ledger'
import { tag } from './product-costs'
import { codeOf, ok, purchaseInput } from './purchasing'
import { BAKER } from './settings'
import { bought, CAFE, delivery, item, SalesApi, SaleScope, shift } from './sales'

// Today's sales and One sale, finalized with their cost (ROADMAP.md M3 Step 2; D-219–D-222,
// D-225–D-232), through the API with the dev-only preview of Sales (D-125) and real purchases:
//   - the Spanish Latte sold on a day keeps 3.002034632035 after a milk purchase dated later, after a
//     purchase dated before it but posted after it, and after its own purchase is reversed;
//   - a sale before any purchase of a material shows "no price yet", never 0, and the first purchase
//     that prices it fills it once (and never again);
//   - the owner's time without a team: the minutes kept, the time cost filled once the rate is set;
//   - Today's sales: 40 lattes × 18.00 + 25 croissants × 9.00 = 945.00 + VAT 47.25 = 992.25, typed in
//     Arabic-Indic digits; one sheet per member, day, channel and branch; a sheet for several days;
//   - VAT once per rate, a business not registered for VAT; delivery charged and what it cost;
//   - reverse (open period: as never finalized), the books closed (posting refused; a reversal of a
//     closed day on the first open day, counted there), correct, idempotency;
//   - nothing leaves stock: the ledger, the cost rows and ledgerDrift are unchanged by sales.

let api: SalesApi

beforeAll(() => {
  api = new SalesApi()
})

afterAll(async () => {
  await api.close()
})

describe('the Spanish Latte in a café: the cost of what was sold, frozen on its day', () => {
  let cafe: SaleScope
  let today: string
  let latte: ProductDto
  let materials: Awaited<ReturnType<SaleScope['spanishLatte']>>['materials']
  let packs: Awaited<ReturnType<SaleScope['spanishLatte']>>['packs']
  let sold: SaleDto
  let firstPurchaseId: string
  let before: Awaited<ReturnType<SaleScope['stockState']>>

  beforeAll(async () => {
    cafe = await SaleScope.open(api, CAFE)
    today = await cafe.today()
    ;({ latte, materials, packs } = await cafe.spanishLatte(shift(today, -10)))
    firstPurchaseId = (await cafe.run<{ data: { items: { id: string }[] } }>('purchase.list')).data!
      .data.items[0]!.id
    before = await cafe.stockState()
  }, 120_000)

  it('starts with the channels its answers name: Shop and Online', async () => {
    const channels = await cafe.channels()
    expect(channels.map((c) => [c.name, c.kind]).sort()).toEqual([
      ['Online', 'website'],
      ['Shop', 'shop'],
    ])
  })

  it('a latte sold on a day costs 3.002034632035, each material at the average as of that day', async () => {
    const shop = (await cafe.channels()).find((c) => c.kind === 'shop')!
    sold = await cafe.sell({
      businessDate: shift(today, -8),
      channelId: shop.id,
      lines: [item(latte.id, '1', '18')],
    })
    expect(sold).toMatchObject({
      status: 'posted',
      source: 'single',
      vatRegistered: true,
      netTotal: '18',
      vatTotal: '0.9',
      total: '18.9',
    })
    const [line] = sold.lines
    expect(line).toMatchObject({
      kind: 'item',
      description: latte.name,
      unit: 'piece',
      vatCategory: 'standard',
      vatRate: '5',
      net: '18',
      vat: '0.9',
      costBasis: 'recipe',
      cost: '3.002034632035',
      timeMinutes: null,
      timeCost: null,
    })
    const byMaterial = new Map(line!.materials!.map((m) => [m.materialId, m]))
    expect(byMaterial.get(materials.beans.id)).toMatchObject({
      baseQty: '18',
      cost: '1.17',
      basis: 'purchases_90_days',
    })
    expect(byMaterial.get(materials.milk.id)).toMatchObject({ baseQty: '200', cost: '1.2' })
    expect(byMaterial.get(materials.condensed.id)?.cost).toBe('0.257034632035')
    expect(byMaterial.get(materials.cup.id)?.cost).toBe('0.25')
    expect(byMaterial.get(materials.lid.id)?.cost).toBe('0.09')
    expect(byMaterial.get(materials.straw.id)?.cost).toBe('0.035')
  })

  it('keeps it after a milk purchase dated later, one dated before but posted after, and a reversal of its purchase', async () => {
    // Milk at twice the price, dated after the sale's day.
    await cafe.buy(
      purchaseInput(shift(today, -6), [
        bought(materials.milk.id, '1', '144', { packId: packs.carton }),
      ]),
    )
    // Beans dated the day before the sale, posted only now: not in the sale.
    await cafe.buy(
      purchaseInput(shift(today, -9), [
        bought(materials.beans.id, '1', '200', { packId: packs.bag }),
      ]),
    )
    // The purchase the sale was costed from, reversed.
    await cafe.reverse(firstPurchaseId)
    const again = await cafe.sale(sold.id)
    expect(again.lines[0]?.cost).toBe('3.002034632035')
    expect(again.lines[0]?.materials?.find((m) => m.materialId === materials.milk.id)?.cost).toBe(
      '1.2',
    )
  })

  it('a later sale of the same day prices the purchase dated before it, posted since', async () => {
    const later = await cafe.sell({
      businessDate: shift(today, -8),
      lines: [item(latte.id, '1', '18')],
      channelId: (await cafe.channels()).find((c) => c.kind === 'shop')!.id,
    })
    const beans = later.lines[0]?.materials?.find((m) => m.materialId === materials.beans.id)
    // Only the 200-a-kg bag stands (the first purchase is reversed): 18 g × 0.2.
    expect(beans).toMatchObject({ cost: '3.6', basis: 'purchases_90_days' })
  })

  it('takes nothing out of stock: the ledger, the cost rows and the balances are as purchases left them', async () => {
    const shop = (await cafe.channels()).find((c) => c.kind === 'shop')!
    const purchasesOnly = await cafe.stockState()
    await cafe.sell({
      businessDate: today,
      channelId: shop.id,
      lines: [item(latte.id, '500', '18')],
    })
    expect(await cafe.stockState()).toEqual(purchasesOnly)
    expect(await ledgerDrift(api.admin, cafe.id)).toEqual([])
    expect(before.movements).not.toBe(purchasesOnly.movements)
  })
})

describe('no price yet, filled once by the first purchase that prices it (Q5)', () => {
  let cafe: SaleScope
  let today: string
  let cake: ProductDto
  let flourId: string
  let sold: SaleDto

  beforeAll(async () => {
    cafe = await SaleScope.open(api, CAFE)
    today = await cafe.today()
    const flour = await cafe.newMaterial({ name: `Flour ${tag()}`, unit: 'kg', packs: [] })
    flourId = flour.id
    cake = await cafe.product({ name: `Cake ${tag()}`, defaultPrice: '30' })
    await cafe.recipe(cake.id, [{ id: newId(), materialId: flour.id, qty: '500', unit: 'g' }])
  }, 60_000)

  it('a sale before any purchase of its material says "no price yet", never 0', async () => {
    sold = await cafe.sell({ businessDate: shift(today, -3), lines: [item(cake.id, '2', '30')] })
    const [line] = sold.lines
    expect(line).toMatchObject({ costBasis: 'recipe', cost: null })
    expect(line?.materials).toEqual([
      expect.objectContaining({
        materialId: flourId,
        baseQty: '1000',
        unitCost: null,
        cost: null,
        basis: null,
      }),
    ])
  })

  it('the first purchase fills it once, as of the sale’s day (the first purchase after it)', async () => {
    await cafe.buy(purchaseInput(shift(today, -1), [bought(flourId, '10', '50', { unit: 'kg' })]))
    const filled = await cafe.sale(sold.id)
    // 10 kg at 50 a kg: 0.05 a gram; 2 cakes of 500 g use 1,000 g.
    expect(filled.lines[0]).toMatchObject({ cost: '50' })
    expect(filled.lines[0]?.materials?.[0]).toMatchObject({
      unitCost: '0.05',
      cost: '50',
      basis: 'first_purchase',
    })
    // Another purchase at another price changes nothing: a cost once set never changes.
    await cafe.buy(purchaseInput(today, [bought(flourId, '10', '80', { unit: 'kg' })]))
    expect((await cafe.sale(sold.id)).lines[0]?.cost).toBe('50')
  })

  it('also into a closed month: the books closed on the sale’s day do not stop the fill', async () => {
    const bread = await cafe.product({ name: `Bread ${tag()}`, defaultPrice: '5' })
    const yeast = await cafe.newMaterial({ name: `Yeast ${tag()}`, unit: 'kg', packs: [] })
    await cafe.recipe(bread.id, [{ id: newId(), materialId: yeast.id, qty: '10', unit: 'g' }])
    const early = await cafe.sell({
      businessDate: shift(today, -5),
      lines: [item(bread.id, '1', '5')],
    })
    ok(await cafe.run('books.close', { closedThrough: shift(today, -2) }))
    await cafe.buy(purchaseInput(today, [bought(yeast.id, '1', '20', { unit: 'kg' })]))
    expect((await cafe.sale(early.id)).lines[0]?.cost).toBe('0.2')
    ok(await cafe.run('books.close', { closedThrough: null }))
  })
})

describe('the owner’s time without a team (D-119, Q7)', () => {
  let baker: SaleScope
  let today: string
  let cake: ProductDto
  let sold: SaleDto

  beforeAll(async () => {
    baker = await SaleScope.open(api, BAKER)
    today = await baker.today()
    cake = await baker.product({
      name: `Chocolate cake ${tag()}`,
      defaultPrice: '150',
      ownerMinutes: '60',
    })
  }, 60_000)

  it('starts with the channel its answers name: WhatsApp & phone', async () => {
    expect((await baker.channels()).map((c) => [c.name, c.kind])).toEqual([
      ['WhatsApp & phone', 'messages'],
    ])
  })

  it('keeps the minutes without a rate, then takes the rate once when it is set', async () => {
    sold = await baker.sell({ businessDate: today, lines: [item(cake.id, '1', '150')] })
    expect(sold).toMatchObject({ vatRegistered: false, vatTotal: '0', total: '150' })
    expect(sold.lines[0]).toMatchObject({
      vatCategory: null,
      vatRate: null,
      costBasis: 'none',
      cost: null,
      timeMinutes: '60',
      timeCost: null,
    })
    await baker.settings({ ownerHourlyRate: '40' })
    expect((await baker.sale(sold.id)).lines[0]?.timeCost).toBe('40')
    await baker.settings({ ownerHourlyRate: '50' })
    expect((await baker.sale(sold.id)).lines[0]?.timeCost).toBe('40')
    // A sale finalized with the rate set takes it at once.
    const next = await baker.sell({ businessDate: today, lines: [item(cake.id, '2', '150')] })
    expect(next.lines[0]).toMatchObject({ timeMinutes: '120', timeCost: '100' })
  })

  it('delivery charged as a line, what it cost the business, and the fill once of a missing one', async () => {
    const withCost = await baker.sell({
      businessDate: today,
      deliveryNeeded: true,
      deliveryArea: 'Al Barsha',
      deliveryCost: '25',
      lines: [item(cake.id, '1', '150'), delivery('20', { description: 'Delivery' })],
    })
    expect(withCost).toMatchObject({
      netTotal: '170',
      total: '170',
      deliveryNeeded: true,
      deliveryArea: 'Al Barsha',
      deliveryCost: '25',
      ownDeliveryCost: '25',
    })
    expect(withCost.lines[1]).toMatchObject({
      kind: 'delivery',
      qty: '1',
      net: '20',
      costBasis: 'none',
    })

    const without = await baker.sell({
      businessDate: today,
      deliveryNeeded: true,
      deliveryArea: 'JLT',
      lines: [item(cake.id, '1', '150'), delivery('20')],
    })
    expect(without.deliveryCost).toBeNull()
    const filled = ok(
      await baker.run<{ data: SaleDto }>('sale.fillDeliveryCost', {
        id: without.id,
        deliveryCost: '22',
      }),
    ).data
    expect(filled.deliveryCost).toBe('22')
    expect(
      codeOf(await baker.run('sale.fillDeliveryCost', { id: without.id, deliveryCost: '30' })),
    ).toBe('document_posted')
    expect(
      codeOf(await baker.run('sale.fillDeliveryCost', { id: sold.id, deliveryCost: '30' })),
    ).toBe('validation')
  })

  it('refuses "price includes VAT" on a delivery without VAT registration (D-192, D-206)', async () => {
    const refused = await baker.run('sale.create', {
      id: newId(),
      source: 'single',
      businessDate: today,
      deliveryNeeded: true,
      lines: [item(cake.id, '1', '150'), delivery('20', { amountIncludesVat: true })],
    })
    expect(codeOf(refused)).toBe('capability_disabled')
  })
})

describe('Today’s sales in a café (Q9, Q10)', () => {
  let cafe: SaleScope
  let today: string
  let latte: ProductDto
  let croissant: ProductDto
  let shopId: string

  beforeAll(async () => {
    cafe = await SaleScope.open(api, CAFE)
    today = await cafe.today()
    latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    croissant = await cafe.product({ name: `Croissant ${tag()}`, defaultPrice: '9' })
    shopId = (await cafe.channels()).find((c) => c.kind === 'shop')!.id
  }, 60_000)

  it('40 lattes × 18.00 + 25 croissants × 9.00 = 945.00 + VAT 47.25 = 992.25, typed in Arabic-Indic digits', async () => {
    const empty = await cafe.sheet({ businessDate: today, channelId: shopId })
    expect(empty.sheet).toBeNull()
    // One location: no branch to pick.
    expect(empty.locations).toBeNull()
    expect(empty.products.map((p) => [p.name, p.price])).toEqual(
      expect.arrayContaining([
        [latte.name, '18'],
        [croissant.name, '9'],
      ]),
    )
    const sheet = await cafe.sell({
      source: 'day_sheet',
      businessDate: today,
      channelId: shopId,
      lines: [item(latte.id, '٤٠', '١٨'), item(croissant.id, '٢٥', '٩٫٠٠')],
    })
    expect(sheet).toMatchObject({
      source: 'day_sheet',
      netTotal: '945',
      vatTotal: '47.25',
      total: '992.25',
    })
    // Asking again opens it; the products the member sold most come first, with their last price.
    const again = await cafe.sheet({ businessDate: today, channelId: shopId })
    expect(again.sheet?.id).toBe(sheet.id)
    expect(again.products.slice(0, 2).map((p) => p.name)).toEqual([latte.name, croissant.name])
    expect(again.sheets?.map((s) => s.saleId)).toEqual([sheet.id])
    // A second sheet of the same member for the same day, channel and branch: CONFLICT.
    const second = await cafe.run('sale.create', {
      id: newId(),
      source: 'day_sheet',
      businessDate: today,
      channelId: shopId,
      lines: [item(latte.id, '1', '18')],
    })
    expect(codeOf(second)).toBe('conflict')
  })

  it('a product sold without its recipe says so (its cost is not known); a service has nothing to cost', async () => {
    // A café of its own: this case's sales stay out of the day totals below.
    const other = await SaleScope.open(api, CAFE)
    const day = await other.today()
    const bun = await other.product({ name: `Bun ${tag()}`, defaultPrice: '9' })
    const tasting = await other.product({
      name: `Tasting ${tag()}`,
      defaultPrice: '50',
      type: 'service',
    })
    const sale = await other.sell({
      businessDate: day,
      lines: [item(bun.id, '1', '9'), item(tasting.id, '1', '50')],
    })
    expect(sale.lines.map((l) => [l.costBasis, l.cost, l.noRecipe])).toEqual([
      ['none', null, true],
      ['none', null, false],
    ])
    // A draft says nothing yet.
    const draft = await other.saleDraft({ businessDate: day, lines: [item(bun.id, '1', '9')] })
    expect(draft.lines[0]?.noRecipe).toBe(false)
  }, 60_000)

  it('two members’ sheets for the same day add up, and the manager sees both', async () => {
    const barista = await api.member(cafe, 'employee')
    const theirs = await cafe.sell(
      {
        source: 'day_sheet',
        businessDate: today,
        channelId: shopId,
        lines: [item(latte.id, '10', '18')],
      },
      barista,
    )
    expect(theirs.mine).toBe(true)
    const owners = await cafe.sheet({ businessDate: today, channelId: shopId })
    expect(owners.sheets).toHaveLength(2)
    expect(owners.sheets?.find((s) => s.saleId === theirs.id)?.mine).toBe(false)
    // The barista sees only their own sheet, and no one else's.
    const baristas = await cafe.sheet({ businessDate: today, channelId: shopId }, barista)
    expect(baristas.sheet?.id).toBe(theirs.id)
    expect(baristas.sheets).toBeNull()
    const list = await cafe.sales({ from: today, to: today })
    expect(list.dayTotals).toEqual([
      { businessDate: today, netTotal: '1125', total: '1181.25', count: 2 },
    ])
  })

  it('a sheet for several days of one month posts one sale on its last day', async () => {
    const lastMonth = `${shift(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}`
    const lastDay = shift(`${today.slice(0, 7)}-01`, -1)
    const month = await cafe.sell({
      source: 'day_sheet',
      businessDate: lastDay,
      periodFrom: `${lastMonth}-01`,
      channelId: shopId,
      lines: [item(croissant.id, '300', '9')],
    })
    expect(month).toMatchObject({
      businessDate: lastDay,
      periodFrom: `${lastMonth}-01`,
      netTotal: '2700',
    })
    const across = await cafe.run('sale.create', {
      id: newId(),
      source: 'day_sheet',
      businessDate: today,
      periodFrom: shift(`${today.slice(0, 7)}-01`, -3),
      channelId: shopId,
      lines: [item(croissant.id, '1', '9')],
    })
    expect(codeOf(across)).toBe('validation')
    const future = await cafe.run('sale.create', {
      id: newId(),
      source: 'single',
      businessDate: shift(today, 1),
      channelId: shopId,
      lines: [item(croissant.id, '1', '9')],
    })
    expect(codeOf(future)).toBe('future_date')
  })
})

describe('VAT once per rate, and reversal, closed books and correction', () => {
  let cafe: SaleScope
  let today: string
  let coffee: ProductDto
  let water: ProductDto

  beforeAll(async () => {
    cafe = await SaleScope.open(api, CAFE)
    today = await cafe.today()
    coffee = await cafe.product({ name: `Coffee ${tag()}`, defaultPrice: '10.10' })
    water = await cafe.product({
      name: `Export water ${tag()}`,
      defaultPrice: '5',
      vatCategory: 'zero_rated',
    })
  }, 60_000)

  it('7 lines of 10.10 at 5%: VAT 3.54 once on the rate, split back over the lines', async () => {
    const sale = await cafe.sell({
      businessDate: today,
      lines: [
        ...Array.from({ length: 7 }, () => item(coffee.id, '1', '10.10')),
        item(water.id, '2', '5'),
      ],
    })
    expect(sale).toMatchObject({ netTotal: '80.7', vatTotal: '3.54', total: '84.24' })
    expect(sale.lines.slice(0, 7).map((l) => l.vat)).toEqual([
      '0.51',
      '0.51',
      '0.51',
      '0.51',
      '0.5',
      '0.5',
      '0.5',
    ])
    expect(sale.lines[7]).toMatchObject({ vatCategory: 'zero_rated', vatRate: '0', vat: '0' })
  })

  it('a reversal in an open period is as if never finalized; correct opens a copy; both idempotent', async () => {
    const sale = await cafe.sell({ businessDate: today, lines: [item(coffee.id, '3', '10.10')] })
    const reversed = await cafe.reverseSale(sale.id)
    expect(reversed).toMatchObject({ status: 'reversed', reversalBusinessDate: today })
    expect((await cafe.reverseSale(sale.id)).reversedAt).toBe(reversed.reversedAt)
    const other = await cafe.sell({ businessDate: today, lines: [item(coffee.id, '1', '10.10')] })
    const newIdOfCopy = newId()
    const copy = ok(
      await cafe.run<{ data: SaleDto }>('sale.correct', { id: other.id, newId: newIdOfCopy }),
    ).data
    expect(copy).toMatchObject({ id: newIdOfCopy, status: 'draft', copiedFromId: other.id })
    expect(copy.lines.map((l) => [l.productId, l.qty])).toEqual([[coffee.id, '1']])
    const replay = ok(
      await cafe.run<{ data: SaleDto }>('sale.correct', { id: other.id, newId: newIdOfCopy }),
    ).data
    expect(replay.id).toBe(newIdOfCopy)
    expect((await cafe.sale(other.id)).status).toBe('reversed')
    expect(codeOf(await cafe.run('sale.correct', { id: copy.id, newId: newId() }))).toBe(
      'document_not_posted',
    )
  })

  it('the books closed: nothing finalized on a closed day; a closed day’s sale reversed on the first open day, counted there', async () => {
    const yesterday = shift(today, -1)
    const old = await cafe.sell({
      businessDate: yesterday,
      lines: [item(coffee.id, '10', '10.10')],
    })
    const draft = await cafe.saleDraft({
      businessDate: yesterday,
      lines: [item(coffee.id, '1', '10.10')],
    })
    ok(await cafe.run('books.close', { closedThrough: yesterday }))
    expect(codeOf(await cafe.run('sale.post', { id: draft.id, version: draft.version }))).toBe(
      'books_closed',
    )
    const reversed = await cafe.reverseSale(old.id)
    expect(reversed).toMatchObject({ status: 'reversed', reversalBusinessDate: today })
    const list = await cafe.sales({ from: yesterday, to: today })
    const yesterdays = list.dayTotals?.find((d) => d.businessDate === yesterday)
    const todays = list.dayTotals?.find((d) => d.businessDate === today)
    // Yesterday keeps the sale (its month's sales do not change); today takes it back.
    expect(yesterdays).toMatchObject({ netTotal: '101', count: 1 })
    expect(Number(todays?.netTotal ?? '0')).toBeLessThan(0)
    ok(await cafe.run('books.close', { closedThrough: null }))
  })

  it('idempotency: the same create twice is one sale; another payload with its id is CONFLICT; a second post returns it', async () => {
    const input = {
      id: newId(),
      source: 'single',
      businessDate: today,
      channelId: await cafe.channelId(),
      lines: [item(coffee.id, '2', '10.10')],
    }
    const first = ok(await cafe.run<{ data: SaleDto }>('sale.create', input)).data
    const second = ok(await cafe.run<{ data: SaleDto }>('sale.create', input)).data
    expect(second.id).toBe(first.id)
    expect(
      codeOf(await cafe.run('sale.create', { ...input, lines: [item(coffee.id, '3', '10.10')] })),
    ).toBe('conflict')
    const posted = await cafe.postSale(first)
    const again = await cafe.postSale(first)
    expect(again.postedAt).toBe(posted.postedAt)
    expect(codeOf(await cafe.run('sale.update', { ...input, version: posted.version }))).toBe(
      'document_posted',
    )
  })

  it('the last active channel stays; a channel’s commission % only with the costs switch', async () => {
    const channels = await cafe.channels()
    const talabat = await cafe.channel({ name: `Talabat ${tag()}`, feePercent: '20' })
    expect(talabat.feePercent).toBe('20')
    for (const c of channels) ok(await cafe.run('channel.archive', { id: c.id }))
    expect(codeOf(await cafe.run('channel.archive', { id: talabat.id }))).toBe('last_channel')
    for (const c of channels) ok(await cafe.run('channel.unarchive', { id: c.id }))
    const manager = await api.member(cafe, 'manager')
    const overridden = await api.member(cafe, 'sales')
    expect(codeOf(await cafe.as(overridden, 'channel.list'))).toBeUndefined()
    const seen = ok(
      await cafe.as<{
        data: { items: { id: string; feePercent?: string | null }[] }
        meta: { redacted: string[] }
      }>(overridden, 'channel.list'),
    )
    expect(seen.meta.redacted).toEqual(['items.*.feePercent'])
    expect(seen.data.items.find((c) => c.id === talabat.id)).not.toHaveProperty('feePercent')
    const renamed = ok(
      await cafe.as<{ data: { feePercent: string | null; name: string } }>(
        manager,
        'channel.update',
        {
          id: talabat.id,
          version: talabat.version,
          name: `Talabat app ${tag()}`,
          kind: 'delivery_app',
        },
      ),
    ).data
    // Left out, the commission is kept.
    expect(renamed.feePercent).toBe('20')
  })
})
