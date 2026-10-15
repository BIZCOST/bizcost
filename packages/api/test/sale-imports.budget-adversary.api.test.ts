import { createHash } from 'node:crypto'
import type { ProductDto, SaleImportDto } from '@bizcost/contracts'
import { IMPORT_ROWS_CHUNK } from '@bizcost/contracts'
import {
  addMonths,
  daysIn,
  monthOf,
  newId,
  readImportRows,
  SALE_LINE_QTY_MAX,
  type BusinessMonth,
  type ImportCell,
  type ImportRead,
} from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tag } from './product-costs'
import { ProfitApi, ProfitScope } from './profit'
import { ok } from './purchasing'
import { CAFE } from './sales'

// The plan's budget "a 50,000-row line file finalizes in under 10 s locally" (M3 Step 4), measured on
// a file shaped like a shop's item-wise export rather than a café's: the step's own budget test sums
// its 50,000 rows into 3,720 day × item totals (120 items × 31 days, as many as one branch of its
// 5 s test). Here a shop of SHOP_ITEMS items sells each of them every day of a 31-day month, so the
// same 50,000 rows stay SHOP_ITEMS × 31 day × item totals. Products are plain (no recipe), so the
// finalizing has less to cost than the step's own test.

const FILE_BUDGET_MS = 10_000
const FILE_ROWS = 50_000
const SHOP_ITEMS = 1000

let api: ProfitApi
let shop: ProfitScope
let month: BusinessMonth
let products: ProductDto[]

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

function longMonthBefore(today: string): BusinessMonth {
  let m = addMonths(monthOf(today), -1)
  while (daysIn(m) !== 31) m = addMonths(m, -1)
  return m
}

/** A line file of FILE_ROWS rows: each day sells every item at least once, as a shop exports it. */
function lineFile(): ImportCell[][] {
  const file: ImportCell[][] = [['Date', 'Item', 'Qty', 'Net sales']]
  const perDay = Math.ceil(FILE_ROWS / 31)
  for (let i = 0; i < FILE_ROWS; i++) {
    const product = products[i % SHOP_ITEMS]!
    const day = 1 + Math.floor(i / perDay)
    const qty = 1 + (i % 3)
    file.push([
      `${String(day).padStart(2, '0')}/${month.slice(5, 7)}/${month.slice(0, 4)}`,
      product.name,
      String(qty),
      `${qty * (10 + (i % 40))}.00`,
    ])
  }
  return file
}

beforeAll(async () => {
  api = new ProfitApi()
  shop = await ProfitScope.open(api, CAFE)
  month = longMonthBefore(await shop.today())
  products = []
  for (let p = 0; p < SHOP_ITEMS; p += 10) {
    products.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(10, SHOP_ITEMS - p) }, (_, k) =>
          shop.product({ name: `Item ${p + k} ${tag()}`, defaultPrice: '10' }),
        ),
      )),
    )
  }
}, 600_000)

afterAll(async () => {
  await api.close()
})

describe('the 10 s budget on a shop-shaped file', () => {
  it(`a line file of ${FILE_ROWS} rows (${SHOP_ITEMS} items) is read, sent and finalized in under ${FILE_BUDGET_MS} ms`, async () => {
    const channelId = await shop.channelId()
    const file = lineFile()
    const started = performance.now()
    const read: ImportRead = readImportRows(file, {
      mapping: { date: 0, name: 1, qty: 2, net: 3 },
      headerRow: 0,
      dateOrder: 'dmy',
      vatRegistered: true,
      amountsIncludeVat: null,
      period: null,
      minorUnit: 2,
      qtyMax: SALE_LINE_QTY_MAX,
    })
    expect(read.problem).toBeNull()
    const id = newId()
    ok(
      await shop.run('saleImport.create', {
        id,
        channelId,
        fileName: 'shop.csv',
        fileHash: hashOf(`shop ${tag()}`),
        fingerprint: hashOf('shop layout'),
        shape: 'lines',
        periodFrom: read.period!.from,
        periodTo: read.period!.to,
        mapping: {
          headerRow: 0,
          columns: { date: 0, name: 1, qty: 2, net: 3 },
          headers: { date: 'Date', name: 'Item', qty: 'Qty', net: 'Net sales' },
          dateOrder: 'dmy',
        },
        amountsIncludeVat: read.amountsIncludeVat,
        rowsRead: read.rowsRead,
        rowsLeftOut: read.rowsLeftOut,
        errors: [],
        feesTotal: null,
        rowCount: read.items.length,
      }),
    )
    const rows = read.items.map((item, position) => ({
      position,
      businessDate: item.day,
      name: item.name,
      code: item.code,
      qty: item.qty,
      amount: item.amount,
      refunds: item.refunds,
      fileRows: item.rows,
    }))
    for (let i = 0; i < rows.length; i += IMPORT_ROWS_CHUNK) {
      ok(await shop.run('saleImport.addRows', { id, rows: rows.slice(i, i + IMPORT_ROWS_CHUNK) }))
    }
    // The wizard opens the import's page (its preview) before Finalize.
    const draft = ok(await shop.run<{ data: SaleImportDto }>('saleImport.get', { id })).data
    expect(draft.matchedNames).toBe(draft.totalNames)
    const posted = ok(
      await shop.run<{ data: SaleImportDto }>('saleImport.post', { id, version: draft.version }),
    ).data
    const elapsed = performance.now() - started
    console.info(
      `budget (shop): ${FILE_ROWS} rows, ${read.items.length} day × item totals, ${Math.round(elapsed)} ms`,
    )
    expect(posted.status).toBe('posted')
    expect(elapsed).toBeLessThan(FILE_BUDGET_MS)
  }, 300_000)
})
