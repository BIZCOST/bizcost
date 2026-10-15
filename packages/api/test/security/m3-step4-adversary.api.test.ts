import { createHash } from 'node:crypto'
import type { LocationDto, ProductDto, SaleImportDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember, type CallResult } from '../helpers'
import { tag } from '../product-costs'
import { codeOf, ok, type Person } from '../purchasing'
import { CAFE, CAFE_BRANCHES, item, SalesApi, SaleScope, shift } from '../sales'

// ADVERSARY (M3 Step 4: importing sales from a file, and app fees by channel). Each case below FAILS
// on the code as built and names the rule it breaks:
//   1. "Replace" reverses the sales of an import the caller cannot even open (D-231: a member without
//      "see every sale" acts only on their own; NOT_FOUND for another's).
//   2. `saleImport.reverse` reverses finalized sales without `sales.documents.reverse` (PERMISSION_NEEDS:
//      "reversing one needs to see every sale"; Q10: the Sales template enters and finalizes, never
//      reverses).
//   3. A fee column posts the channel's statement without `sales.channels.manage` (the plan's Keys:
//      "statements need sales.channels.manage and the costs switch").
//   4. ALREADY_IMPORTED and the preview's `importedBy` hand out the id of an import the caller gets
//      NOT_FOUND for (another branch's, another member's).
//   5. The preview matches every unmatched name against every product in the API process, inside the
//      transaction: one draft of many distinct names pins the server's CPU on each get.

let api: SalesApi

beforeAll(() => {
  api = new SalesApi()
})

afterAll(async () => {
  await api.close()
})

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

const LINES_MAPPING = {
  headerRow: 0,
  columns: { date: 0, name: 1, qty: 2, net: 3 },
  headers: { date: 'Date', name: 'Item', qty: 'Qty', net: 'Net sales' },
  dateOrder: 'dmy',
} as const

interface Row {
  businessDate: string
  name: string
  qty: string
  amount: string
}

/** A draft import of `rows` (a line file) as `person`; the create's result when it is refused. */
async function importDraft(
  scope: SaleScope,
  person: Person,
  input: {
    channelId: string
    rows: readonly Row[]
    file: string
    locationId?: string | null
    feesTotal?: string | null
  },
): Promise<{ id: string; created: CallResult<{ data: SaleImportDto }> }> {
  const days = input.rows.map((r) => r.businessDate).sort()
  const id = newId()
  const created = await scope.as<{ data: SaleImportDto }>(person, 'saleImport.create', {
    id,
    channelId: input.channelId,
    locationId: input.locationId ?? null,
    fileName: `${input.file}.csv`,
    fileHash: hashOf(input.file),
    fingerprint: hashOf('layout lines'),
    shape: 'lines',
    periodFrom: days[0],
    periodTo: days.at(-1),
    mapping: LINES_MAPPING,
    amountsIncludeVat: false,
    rowsRead: input.rows.length,
    rowsLeftOut: 0,
    errors: [],
    feesTotal: input.feesTotal ?? null,
    rowCount: input.rows.length,
  })
  if (created.error) return { id, created }
  for (let start = 0; start < input.rows.length; start += 1000) {
    ok(
      await scope.as(person, 'saleImport.addRows', {
        id,
        rows: input.rows.slice(start, start + 1000).map((r, i) => ({
          position: start + i,
          businessDate: r.businessDate,
          name: r.name,
          code: null,
          qty: r.qty,
          amount: r.amount,
          refunds: '0',
          fileRows: 1,
        })),
      }),
    )
  }
  return { id, created }
}

async function importOf(scope: SaleScope, person: Person, id: string): Promise<SaleImportDto> {
  return ok(await scope.as<{ data: SaleImportDto }>(person, 'saleImport.get', { id })).data
}

async function finalize(scope: SaleScope, person: Person, id: string) {
  const fresh = await importOf(scope, person, id)
  return scope.as<{ data: SaleImportDto }>(person, 'saleImport.post', {
    id,
    version: fresh.version,
  })
}

/** A member of `scope` holding `template` with `allow` keys added and `locationIds` (all when none). */
async function memberOf(
  scope: SaleScope,
  template: 'employee' | 'sales',
  allow: readonly string[],
  locationIds: readonly string[] = [],
): Promise<Person> {
  const person = await api.person()
  await addMember(api.db, scope.owner.user, scope.id, person.user, {
    template,
    overrides: allow.map((key) => ({ key, effect: 'allow' as const })),
    locationIds: [...locationIds],
  })
  return person
}

const COSTS = ['data.cost.view', 'data.supplier_price.view', 'data.profit_margin.view']

describe('1. "Replace" never reverses sales the caller cannot see (D-231)', () => {
  it("an Employee who imports only their own leaves the owner's imported day finalized", async () => {
    const cafe = await SaleScope.open(api, CAFE)
    const today = await cafe.today()
    const day = shift(today, -2)
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    const shop = await cafe.channelId()
    const staff = await memberOf(cafe, 'employee', ['sales.imports.manage'])

    const owners = await importDraft(cafe, cafe.owner, {
      channelId: shop,
      file: `owner-day ${tag()}`,
      rows: [{ businessDate: day, name: latte.name, qty: '40', amount: '720' }],
    })
    ok(await finalize(cafe, cafe.owner, owners.id))
    // The premise: the Employee may import, but cannot open the owner's import.
    expect(codeOf(await cafe.as(staff, 'saleImport.get', { id: owners.id }))).toBe('not_found')

    const theirs = await importDraft(cafe, staff, {
      channelId: shop,
      file: `staff-day ${tag()}`,
      rows: [{ businessDate: day, name: latte.name, qty: '1', amount: '18' }],
    })
    const draft = await importOf(cafe, staff, theirs.id)
    await cafe.as(staff, 'saleImport.setOverlap', {
      id: theirs.id,
      version: draft.version,
      overlap: 'replace',
    })
    await finalize(cafe, staff, theirs.id)

    // The owner's 720.00 of that day must still stand (today: reversed by the Employee's file).
    const after = await importOf(cafe, cafe.owner, owners.id)
    expect(after.days.map((d) => [d.businessDate, d.state])).toEqual([[day, 'posted']])
    expect(after.status).toBe('posted')
  })
})

describe('2. Reversing an import needs the reverse key, as reversing a sale does', () => {
  it('a Sales member who may not reverse a sale may not reverse an imported day either', async () => {
    const cafe = await SaleScope.open(api, CAFE)
    const today = await cafe.today()
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    const shop = await cafe.channelId()
    const seller = await memberOf(cafe, 'sales', ['sales.imports.manage'])

    // The premise: their own finalized sale is not theirs to reverse (no sales.documents.reverse).
    const sold = await cafe.sell(
      { businessDate: today, lines: [item(latte.id, '1', '18')] },
      seller,
    )
    expect(codeOf(await cafe.as(seller, 'sale.reverse', { id: sold.id }))).toBe('forbidden')

    const imported = await importDraft(cafe, seller, {
      channelId: shop,
      file: `seller-day ${tag()}`,
      rows: [{ businessDate: shift(today, -1), name: latte.name, qty: '30', amount: '540' }],
    })
    ok(await finalize(cafe, seller, imported.id))
    // Today: ok, and the 540.00 of finalized sales are taken back.
    expect(codeOf(await cafe.as(seller, 'saleImport.reverse', { id: imported.id }))).toBe(
      'forbidden',
    )
    expect((await importOf(cafe, cafe.owner, imported.id)).status).toBe('posted')
  })
})

describe("3. A fee column posts a statement only for who may manage the channel's statements", () => {
  it('a Sales member with the costs switch but without sales.channels.manage posts no statement', async () => {
    const cafe = await SaleScope.open(api, CAFE)
    const today = await cafe.today()
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    const talabat = await cafe.channel({ name: `Talabat ${tag()}`, kind: 'delivery_app' })
    const seller = await memberOf(cafe, 'sales', ['sales.imports.manage', ...COSTS])
    // The premise: statements are not theirs (no sales.channels.manage).
    expect(codeOf(await cafe.as(seller, 'channelStatement.list', { channelId: talabat.id }))).toBe(
      'forbidden',
    )

    const draft = await importDraft(cafe, seller, {
      channelId: talabat.id,
      file: `talabat-fees ${tag()}`,
      feesTotal: '9999',
      rows: [{ businessDate: shift(today, -1), name: latte.name, qty: '10', amount: '180' }],
    })
    if (!draft.created.error) await finalize(cafe, seller, draft.id)

    const [posted] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.channel_statements
       where business_id = ${cafe.id} and channel_id = ${talabat.id} and status = 'posted'`
    // Today: 1, a posted statement of 9,999.00 whose fees replace Talabat's % in real profit.
    expect(posted!.n).toBe(0)
  })
})

describe('4. No id of an import the caller cannot open', () => {
  let cafe: SaleScope
  let today: string
  let branch: LocationDto
  let latte: ProductDto
  let shop: string

  beforeAll(async () => {
    cafe = await SaleScope.open(api, CAFE_BRANCHES)
    today = await cafe.today()
    branch = ok(
      await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    shop = await cafe.channelId()
  }, 120_000)

  it("ALREADY_IMPORTED names no import of another branch (Q12: only one's branches)", async () => {
    const file = `shared-export ${tag()}`
    const owners = await importDraft(cafe, cafe.owner, {
      channelId: shop,
      file,
      rows: [{ businessDate: shift(today, -1), name: latte.name, qty: '5', amount: '90' }],
    })
    ok(await finalize(cafe, cafe.owner, owners.id))
    const limited = await memberOf(cafe, 'sales', ['sales.imports.manage'], [branch.id])
    expect(codeOf(await cafe.as(limited, 'saleImport.get', { id: owners.id }))).toBe('not_found')

    const again = await importDraft(cafe, limited, {
      channelId: shop,
      locationId: branch.id,
      file,
      rows: [{ businessDate: shift(today, -1), name: latte.name, qty: '5', amount: '90' }],
    })
    // Today: already_imported with names [its date, the owner's import id].
    expect(again.created.error?.data.names ?? []).not.toContain(owners.id)
  })

  it("the preview's importedBy names no import of another member (D-231: only one's own)", async () => {
    const day = shift(today, -3)
    const owners = await importDraft(cafe, cafe.owner, {
      channelId: shop,
      file: `owner-week ${tag()}`,
      rows: [{ businessDate: day, name: latte.name, qty: '5', amount: '90' }],
    })
    ok(await finalize(cafe, cafe.owner, owners.id))
    const staff = await memberOf(cafe, 'employee', ['sales.imports.manage'])
    expect(codeOf(await cafe.as(staff, 'saleImport.get', { id: owners.id }))).toBe('not_found')

    const theirs = await importDraft(cafe, staff, {
      channelId: shop,
      file: `staff-week ${tag()}`,
      rows: [{ businessDate: day, name: latte.name, qty: '1', amount: '18' }],
    })
    const preview = await importOf(cafe, staff, theirs.id)
    // Today: { id: <the owner's import>, fileName: '' }.
    expect(preview.days[0]!.importedBy?.id).not.toBe(owners.id)
  })
})

describe("5. One draft's preview never pins the API process", () => {
  it('a draft of 20,000 distinct names against 400 products previews within 2 s', async () => {
    const cafe = await SaleScope.open(api, CAFE)
    const today = await cafe.today()
    // 400 products, written straight to the database (the API would take a minute for them).
    await api.admin`
      insert into app.products_services (id, business_id, name, type, unit, created_by)
      select gen_random_uuid(), ${cafe.id}, 'Product number ' || g || ' special blend', 'product',
             'piece', ${cafe.owner.user.id}
        from generate_series(1, 400) g`
    const draft = await importDraft(cafe, cafe.owner, {
      channelId: await cafe.channelId(),
      file: `many-names ${tag()}`,
      rows: Array.from({ length: 20_000 }, (_, i) => ({
        businessDate: shift(today, -1),
        name: `Item ${i} qwerty uiop`,
        qty: '1',
        amount: '1',
      })),
    })
    const started = performance.now()
    const preview = await importOf(cafe, cafe.owner, draft.id)
    const ms = performance.now() - started
    expect(preview.totalNames).toBe(20_000)
    // Today about 6 s of the API's one thread (and its transaction held) per get; 100,000 names (the
    // row limit) about 30 s; and every match, overlap and finalize call does it again.
    expect(ms).toBeLessThan(2_000)
  }, 300_000)
})
