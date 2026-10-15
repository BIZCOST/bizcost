import { createHash } from 'node:crypto'
import type { LocationDto, MaterialDto, ProductDto, SaleImportDto } from '@bizcost/contracts'
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
import { dayOf, ProfitApi, ProfitScope } from './profit'
import { ok, purchaseInput } from './purchasing'
import { bought, CAFE_BRANCHES, shift } from './sales'

// The time budgets of importing sales (ROADMAP.md M3 Step 4; the plan's risk "Messy files at scale",
// its tests "Budgets"): 2 branches × 31 days × 120 products (each made of 5 materials) finalize in
// under 5 s, and a line file of 50,000 rows is read (as the browser reads it), sent in chunks of
// IMPORT_ROWS_CHUNK and finalized in under 10 s, locally. The products, their recipes and a purchase
// of every material come first through the API; only the finalizing (and the 50,000-row file's whole
// way: its bytes hashed, decoded, split and read, then sent, previewed and finalized) is timed. A
// shop-shaped file (1,000 items, 31,000 day × item totals) is timed by
// sale-imports.budget-adversary.api.test.ts (D-261).

const POST_BUDGET_MS = 5000
const FILE_BUDGET_MS = 10_000
const PRODUCTS = 120
const MATERIALS = 10
const FILE_ROWS = 50_000

let api: ProfitApi
let cafe: ProfitScope
let month: BusinessMonth
let branches: LocationDto[]
let products: ProductDto[]

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

/** The last month before this one with 31 days (all of its days in the past). */
function longMonthBefore(today: string): BusinessMonth {
  let month = addMonths(monthOf(today), -1)
  while (daysIn(month) !== 31) month = addMonths(month, -1)
  return month
}

/** A draft import of `read`'s items at `locationId` in `channelId`, every row sent. */
async function importDraft(
  read: ImportRead,
  channelId: string,
  locationId: string,
  file: string,
  fileHash: string = hashOf(`${file} ${tag()}`),
): Promise<SaleImportDto> {
  const id = newId()
  ok(
    await cafe.run<{ data: SaleImportDto }>('saleImport.create', {
      id,
      channelId,
      locationId,
      fileName: `${file}.csv`,
      fileHash,
      fingerprint: hashOf('budget layout'),
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
    ok(await cafe.run('saleImport.addRows', { id, rows: rows.slice(i, i + IMPORT_ROWS_CHUNK) }))
  }
  return ok(await cafe.run<{ data: SaleImportDto }>('saleImport.get', { id })).data
}

async function finalize(draft: SaleImportDto): Promise<SaleImportDto> {
  return ok(
    await cafe.run<{ data: SaleImportDto }>('saleImport.post', {
      id: draft.id,
      version: draft.version,
    }),
  ).data
}

/** A line file of `rows` rows over `month`: every product sold on every day, as a POS exports it. */
function lineFile(rows: number): ImportCell[][] {
  const file: ImportCell[][] = [['Date', 'Item', 'Qty', 'Net sales']]
  const days = daysIn(month)
  for (let i = 0; i < rows; i++) {
    const product = products[i % PRODUCTS]!
    const day = 1 + (Math.floor(i / PRODUCTS) % days)
    const qty = 1 + (i % 3)
    const price = 10 + (i % PRODUCTS)
    file.push([
      `${String(day).padStart(2, '0')}/${month.slice(5, 7)}/${month.slice(0, 4)}`,
      product.name,
      String(qty),
      `${qty * price}.00`,
    ])
  }
  return file
}

function read(file: ImportCell[][]): ImportRead {
  return readImportRows(file, {
    mapping: { date: 0, name: 1, qty: 2, net: 3 },
    headerRow: 0,
    dateOrder: 'dmy',
    vatRegistered: true,
    amountsIncludeVat: null,
    period: null,
    minorUnit: 2,
    qtyMax: SALE_LINE_QTY_MAX,
  })
}

beforeAll(async () => {
  api = new ProfitApi()
  cafe = await ProfitScope.open(api, CAFE_BRANCHES)
  const today = await cafe.today()
  month = longMonthBefore(today)
  ok(await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }))
  branches = ok(await cafe.run<LocationDto[]>('location.list'))
  expect(branches.length).toBe(2)
  const materials: MaterialDto[] = []
  for (let i = 0; i < MATERIALS; i += 1) {
    materials.push(await cafe.newMaterial({ name: `Material ${i} ${tag()}`, unit: 'piece' }))
  }
  await cafe.buy(
    purchaseInput(
      shift(dayOf(month, 1), -1),
      materials.map((m, i) => bought(m.id, '1000000', String(1 + i / 10), { unit: 'piece' })),
    ),
  )
  products = []
  for (let p = 0; p < PRODUCTS; p += 8) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(8, PRODUCTS - p) }, async (_, k) => {
        const n = p + k
        const product = await cafe.product({
          name: `Item ${n} ${tag()}`,
          defaultPrice: String(10 + n),
        })
        await cafe.recipe(
          product.id,
          [0, 1, 2, 3, 4].map((m) => ({
            id: newId(),
            materialId: materials[(n + m) % MATERIALS]!.id,
            qty: '1',
            unit: 'piece',
          })),
        )
        return product
      }),
    )
    products.push(...batch)
  }
}, 600_000)

afterAll(async () => {
  await api.close()
})

describe('the time budgets of importing sales', () => {
  it(`2 branches × 31 days × ${PRODUCTS} products finalize in under ${POST_BUDGET_MS} ms`, async () => {
    const shop = await cafe.channelId()
    // One file per branch: every product on every day of the month (31 × 120 day × item totals).
    const file = read(lineFile(daysIn(month) * PRODUCTS))
    expect(file.problem).toBeNull()
    expect(file.items).toHaveLength(daysIn(month) * PRODUCTS)
    const drafts = []
    for (const [i, branch] of branches.entries()) {
      drafts.push(await importDraft(file, shop, branch.id, `branch ${i}`))
    }
    for (const draft of drafts)
      expect(draft.names.every((n) => n.match.state === 'matched')).toBe(true)

    const started = performance.now()
    const posted = []
    for (const draft of drafts) posted.push(await finalize(draft))
    const elapsed = performance.now() - started
    console.info(
      `budget: 2 imports of ${file.items.length} day × item totals in ${Math.round(elapsed)} ms`,
    )

    for (const result of posted) {
      expect(result.status).toBe('posted')
      expect(result.days.filter((d) => d.state === 'posted')).toHaveLength(daysIn(month))
    }
    expect(elapsed).toBeLessThan(POST_BUDGET_MS)
  }, 120_000)

  it(`a line file of ${FILE_ROWS} rows is read, sent and finalized in under ${FILE_BUDGET_MS} ms`, async () => {
    const app = await cafe.deliveryApp(null)
    // The file as a POS saves it (UTF-8 with its byte-order mark, CRLF), as bytes picked.
    const bytes = new TextEncoder().encode(
      `\uFEFF${lineFile(FILE_ROWS)
        .map((row) => row.join(','))
        .join('\r\n')}\r\n`,
    )

    const started = performance.now()
    // As the browser does it: the bytes hashed (Web Crypto), decoded and split, then read.
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const fileHash = Buffer.from(digest).toString('hex')
    const rows = new TextDecoder('utf-8')
      .decode(bytes.subarray(3))
      .split('\r\n')
      .filter((line) => line !== '')
      .map((line) => line.split(','))
    const result = read(rows)
    const readMs = performance.now() - started
    expect(result.problem).toBeNull()
    expect(result.rowsRead).toBe(FILE_ROWS)
    const draft = await importDraft(result, app.id, branches[0]!.id, 'big', fileHash)
    const posted = await finalize(draft)
    const elapsed = performance.now() - started
    console.info(
      `budget: ${FILE_ROWS} rows (${bytes.length} bytes, ${result.items.length} day × item totals) hashed and read in ${Math.round(readMs)} ms, finalized in ${Math.round(elapsed)} ms`,
    )

    expect(posted.status).toBe('posted')
    expect(posted.rowsRead).toBe(FILE_ROWS)
    expect(elapsed).toBeLessThan(FILE_BUDGET_MS)
  }, 120_000)
})
