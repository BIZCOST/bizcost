import { createHash } from 'node:crypto'
import type { ImportNameDto, ProductDto, SaleImportDto, SalesChannelDto } from '@bizcost/contracts'
import { newId, type BusinessMonth } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tag } from './product-costs'
import { connectApi, handlerFor, SECRET_KEY } from './helpers'
import { codeOf, ok } from './purchasing'
import { dayOf, lastOf, PROFIT_PREVIEW, ProfitApi, ProfitScope } from './profit'
import { CAFE } from './sales'

// Import correctness, adversarial (M3 Step 4): cases the step's own suites do not reach. Each test
// states what must hold; a failing one is a defect of the importer, not of the test.
//   - "Replace" reverses every earlier imported sale inside the new file's first–last days, not only
//     the days it posts: a line file of the 5th and the 9th takes back the 6th–8th too, and one day
//     that a multi-day summary covers takes back the summary's whole sale (its other days lost).
//   - Retail files: two item codes that share a name (sizes). The answer given for one code is
//     overridden by the name's alias of the other; "Add all as new" refuses them (NAME_TAKEN).
//   - Two imports of the same channel, branch and day finalized at the same time both post (the
//     overlap check reads before either commits): the day is counted twice.

let api: ProfitApi
let cafe: ProfitScope
let shop: SalesChannelDto
let last: BusinessMonth

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

const LINES_MAPPING = {
  headerRow: 0,
  columns: { date: 0, code: 1, name: 2, qty: 3, net: 4 },
  headers: { date: 'Date', code: 'SKU', name: 'Item', qty: 'Qty', net: 'Net sales' },
  dateOrder: 'dmy',
} as const

const SUMMARY_MAPPING = {
  headerRow: 0,
  columns: { name: 0, qty: 1, net: 2 },
  headers: { name: 'Item', qty: 'Qty', net: 'Net sales' },
  dateOrder: 'dmy',
} as const

interface Row {
  businessDate: string
  name: string
  qty: string
  amount: string
  code?: string | null
}

async function draft(input: {
  rows: readonly Row[]
  shape: 'lines' | 'summary'
  periodFrom?: string
  periodTo?: string
  channelId?: string
}): Promise<SaleImportDto> {
  const days = input.rows.map((r) => r.businessDate).sort()
  const id = newId()
  ok(
    await cafe.run<{ data: SaleImportDto }>('saleImport.create', {
      id,
      channelId: input.channelId ?? shop.id,
      fileName: `file-${tag()}.csv`,
      fileHash: hashOf(`file ${tag()} ${newId()}`),
      fingerprint: hashOf(`layout ${input.shape}`),
      shape: input.shape,
      periodFrom: input.periodFrom ?? days[0],
      periodTo: input.periodTo ?? days.at(-1),
      mapping: input.shape === 'lines' ? LINES_MAPPING : SUMMARY_MAPPING,
      amountsIncludeVat: false,
      rowsRead: input.rows.length,
      rowsLeftOut: 0,
      errors: [],
      feesTotal: null,
      rowCount: input.rows.length,
    }),
  )
  ok(
    await cafe.run('saleImport.addRows', {
      id,
      rows: input.rows.map((r, position) => ({
        position,
        businessDate: r.businessDate,
        name: r.name,
        code: r.code ?? null,
        qty: r.qty,
        amount: r.amount,
        refunds: '0',
        fileRows: 1,
      })),
    }),
  )
  return importOf(id)
}

async function importOf(id: string): Promise<SaleImportDto> {
  return ok(await cafe.run<{ data: SaleImportDto }>('saleImport.get', { id })).data
}

async function finalize(id: string) {
  const fresh = await importOf(id)
  return cafe.run<{ data: SaleImportDto }>('saleImport.post', { id, version: fresh.version })
}

beforeAll(async () => {
  api = new ProfitApi()
  cafe = await ProfitScope.open(api, CAFE)
  ;({ last } = await cafe.months())
  shop = (await cafe.channels()).find((c) => c.kind === 'shop')!
}, 120_000)

afterAll(async () => {
  await api.close()
})

describe('"replace" takes back only the days the new file posts', () => {
  it("never takes back the summary's other days", async () => {
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    // A POS summary for the whole of last month: one sale on its last day, covering 1 → last.
    const summary = await draft({
      shape: 'summary',
      periodFrom: dayOf(last, 1),
      periodTo: lastOf(last),
      rows: [{ businessDate: lastOf(last), name: latte.name, qty: '900', amount: '16200' }],
    })
    expect(ok(await finalize(summary.id)).data.status).toBe('posted')

    // A corrected file for one day (the 15th), finalized with "replace".
    const day = dayOf(last, 15)
    const fix = await draft({
      shape: 'lines',
      rows: [{ businessDate: day, name: latte.name, qty: '30', amount: '540' }],
    })
    expect(fix.days).toEqual([expect.objectContaining({ businessDate: day, state: 'imported' })])
    ok(
      await cafe.run('saleImport.setOverlap', {
        id: fix.id,
        version: fix.version,
        overlap: 'replace',
      }),
    )
    await finalize(fix.id)

    // Whatever happens to the 15th, the month's other 29–30 days of sales must not vanish: either the
    // replace is refused, or the summary's sale stays.
    const after = await importOf(summary.id)
    expect(after.status).toBe('posted')
    expect(after.days.filter((d) => d.state === 'posted')).toHaveLength(1)
    // As built (D-260), the replace is refused and says why.
    expect(codeOf(await finalize(fix.id))).toBe('import_replace_partial')

    // The month is left as found for the cases below, which import days of the same month.
    const fixNow = await importOf(fix.id)
    if (fixNow.status === 'draft') {
      ok(await cafe.run('saleImport.discard', { id: fix.id, version: fixNow.version }))
    }
    ok(await cafe.run('saleImport.reverse', { id: summary.id }))
  })

  it('a line file that skips days replaces only the days it has', async () => {
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    const days = [5, 6, 7, 8, 9].map((n) => dayOf(last, n))
    const first = await draft({
      shape: 'lines',
      rows: days.map((d) => ({ businessDate: d, name: latte.name, qty: '10', amount: '180' })),
    })
    expect(ok(await finalize(first.id)).data.status).toBe('posted')
    // A corrected file for the 5th and the 9th only (nothing in between).
    const fix = await draft({
      shape: 'lines',
      rows: [days[0]!, days[4]!].map((d) => ({
        businessDate: d,
        name: latte.name,
        qty: '12',
        amount: '216',
      })),
    })
    expect(fix.days.map((d) => [d.businessDate, d.state])).toEqual([
      [days[0], 'imported'],
      [days[4], 'imported'],
    ])
    ok(
      await cafe.run('saleImport.setOverlap', {
        id: fix.id,
        version: fix.version,
        overlap: 'replace',
      }),
    )
    const replaced = ok(await finalize(fix.id)).data
    expect(replaced.replacedDays).toEqual([days[0], days[4]])
    const earlier = await importOf(first.id)
    expect(earlier.days.map((d) => [d.businessDate, d.state])).toEqual([
      [days[0], 'reversed'],
      [days[1], 'posted'],
      [days[2], 'posted'],
      [days[3], 'posted'],
      [days[4], 'reversed'],
    ])
  })
})

describe('retail: two item codes that share a name', () => {
  let small: ProductDto
  let large: ProductDto
  let name: string

  beforeAll(async () => {
    const t = tag()
    name = `Milk ${t}`
    small = await cafe.product({ name: `Milk 1 L ${t}`, defaultPrice: '5' })
    large = await cafe.product({ name: `Milk 2 L ${t}`, defaultPrice: '9' })
  })

  it('keeps the answer given for each code', async () => {
    const day = dayOf(last, 3)
    const file = await draft({
      shape: 'lines',
      rows: [
        { businessDate: day, name, code: `111-${name}`, qty: '3', amount: '15' },
        { businessDate: day, name, code: `222-${name}`, qty: '2', amount: '18' },
      ],
    })
    expect(file.matchedNames).toBe(0)
    const answered = ok(
      await cafe.run<{ data: SaleImportDto }>('saleImport.match', {
        id: file.id,
        answers: [
          { name, code: `111-${name}`, target: 'product', productId: small.id },
          { name, code: `222-${name}`, target: 'product', productId: large.id },
        ],
      }),
    ).data
    const byCode = (code: string) => answered.names.find((n: ImportNameDto) => n.code === code)!
    expect(byCode(`111-${name}`).match).toMatchObject({ state: 'matched', productId: small.id })
    expect(byCode(`222-${name}`).match).toMatchObject({ state: 'matched', productId: large.id })
    ok(await cafe.run('saleImport.discard', { id: file.id, version: answered.version }))
  })

  it('"Add all as new" takes two codes of one name', async () => {
    const t = tag()
    const shared = `Juice ${t}`
    const day = dayOf(last, 4)
    const file = await draft({
      shape: 'lines',
      rows: [
        { businessDate: day, name: shared, code: `J-250-${t}`, qty: '4', amount: '20' },
        { businessDate: day, name: shared, code: `J-500-${t}`, qty: '2', amount: '16' },
      ],
    })
    expect(file.matchedNames).toBe(0)
    // What the names step sends for "Add all as new" (one answer per unmatched name, each a new id).
    const added = await cafe.run<{ data: SaleImportDto }>('saleImport.match', {
      id: file.id,
      answers: file.names.map((n) => ({
        name: n.name,
        code: n.code,
        target: 'new',
        productId: newId(),
      })),
    })
    expect(codeOf(added)).toBeUndefined()
  })
})

describe('two imports of one channel, branch and day finalized at once', () => {
  it('count the day once', async () => {
    const latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    const day = dayOf(last, 20)
    // The same day exported twice (two exports of the POS: different bytes, the same sales).
    const a = await draft({
      shape: 'lines',
      rows: [{ businessDate: day, name: latte.name, qty: '50', amount: '900' }],
    })
    const b = await draft({
      shape: 'lines',
      rows: [{ businessDate: day, name: latte.name, qty: '50', amount: '900' }],
    })
    const [va, vb] = await Promise.all([importOf(a.id), importOf(b.id)])
    // Two API instances, each with its own database connection (as two servers, or two requests).
    const db = connectApi()
    const second = handlerFor(db, undefined, {
      supabaseSecretKey: SECRET_KEY,
      previewModules: PROFIT_PREVIEW,
    })
    try {
      await Promise.all([
        cafe.run('saleImport.post', { id: a.id, version: va.version }),
        api.call(cafe.owner, cafe.id, 'saleImport.post', { id: b.id, version: vb.version }, second),
      ])
    } finally {
      await db.$client.end()
    }
    const [counted] = await api.admin<{ n: number; net: string | null }[]>`
      select count(*)::int as n, sum(s.net_total)::text as net
        from app.sales s
       where s.business_id = ${cafe.id} and s.source = 'import' and s.status = 'posted'
         and s.channel_id = ${shop.id} and s.business_date = ${day}::date
         and s.import_id in (${a.id}::uuid, ${b.id}::uuid)`
    expect(counted).toMatchObject({ n: 1 })
  })
})
