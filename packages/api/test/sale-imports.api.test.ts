import { createHash } from 'node:crypto'
import type {
  ChannelStatementDto,
  ImportListDto,
  ProductDto,
  SaleImportDto,
  SalesChannelDto,
} from '@bizcost/contracts'
import { addMonths, daysIn, monthOf, newId, statementParts } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tag } from './product-costs'
import { codeOf, ok, type Person } from './purchasing'
import { dayOf, lastOf, ProfitApi, ProfitScope } from './profit'
import { CAFE, shift } from './sales'

// Importing sales from a file, and app fees by channel (ROADMAP.md M3 Step 4; the owner's answers Q8
// and Q15 of D-218), through the API with the dev-only preview of Sales and Reports (D-125). The file
// itself is read in the browser (the domain's readers have their own corpus); here the rows arrive as
// the browser sends them (day × item totals) and the plan's cases are checked end to end:
//   - a summary with Arabic names and amounts including VAT: 120 lattes at 2,160.00 before VAT, their
//     cost frozen on the day; "Spanish Latte L" offered as "Did you mean Spanish Latte?", the answer
//     remembered the next time;
//   - no file kept: no Storage object or upload, and a customer column sent by mistake never stays;
//   - the same file twice refused (ALREADY_IMPORTED), and again allowed once its import is reversed;
//   - Finalize refused while a name is unmatched (IMPORT_UNMATCHED);
//   - days already imported skipped by default, or replaced on request; Today's sales and an import of
//     the same channel and day warn each other;
//   - a line file with a fee column makes the channel's statement; Talabat's fees from a statement
//     (18 % of its sales) in place of its 20 % commission; a statement over two months split by days;
//   - statements: overlapping ones refused, closed books refused, reversed.

let api: ProfitApi

beforeAll(() => {
  api = new ProfitApi()
})

afterAll(async () => {
  await api.close()
})

/** A file's SHA-256 (any text stands for a file's bytes). */
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

/** The columns of a summary file: item, quantity and total (with VAT unless said). */
const SUMMARY_MAPPING = {
  headerRow: 0,
  columns: { name: 0, qty: 1, total: 2 },
  headers: { name: 'الصنف', qty: 'الكمية', total: 'الإجمالي' },
  dateOrder: 'dmy',
} as const

const LINES_MAPPING = {
  headerRow: 0,
  columns: { date: 0, code: 1, name: 2, qty: 3, net: 4, fee: 5 },
  headers: {
    date: 'Order date',
    code: 'SKU',
    name: 'Product title',
    qty: 'Quantity',
    net: 'Net sales',
    fee: 'Commission',
  },
  dateOrder: 'dmy',
} as const

interface Row {
  businessDate: string
  name: string
  qty: string
  amount: string
  code?: string | null
  refunds?: string
}

class ImportScope extends ProfitScope {
  static override async open(...args: Parameters<typeof ProfitScope.open>): Promise<ImportScope> {
    const { id, owner } = await args[0].business(args[1])
    return new ImportScope(args[0], id, owner)
  }

  /** A draft import of `rows` (all of them sent), as `person`. */
  async importDraft(
    input: {
      channelId: string
      rows: readonly Row[]
      shape?: 'lines' | 'summary'
      periodFrom?: string
      periodTo?: string
      file?: string
      feesTotal?: string | null
      amountsIncludeVat?: boolean
      mapping?: object
    },
    person: Person = this.owner,
  ): Promise<SaleImportDto> {
    const days = input.rows.map((r) => r.businessDate).sort()
    const id = newId()
    const created = ok(
      await this.as<{ data: SaleImportDto }>(person, 'saleImport.create', {
        id,
        channelId: input.channelId,
        fileName: `${input.file ?? 'sales'}.csv`,
        fileHash: hashOf(input.file ?? `file ${tag()}`),
        fingerprint: hashOf(`layout ${input.shape ?? 'summary'}`),
        shape: input.shape ?? 'summary',
        periodFrom: input.periodFrom ?? days[0],
        periodTo: input.periodTo ?? days.at(-1),
        mapping: input.mapping ?? SUMMARY_MAPPING,
        amountsIncludeVat: input.amountsIncludeVat ?? false,
        rowsRead: input.rows.length,
        rowsLeftOut: 0,
        errors: [],
        feesTotal: input.feesTotal ?? null,
        rowCount: input.rows.length,
      }),
    ).data
    const sent = ok(
      await this.as<{ received: number }>(person, 'saleImport.addRows', {
        id,
        rows: input.rows.map((r, position) => ({
          position,
          businessDate: r.businessDate,
          name: r.name,
          code: r.code ?? null,
          qty: r.qty,
          amount: r.amount,
          refunds: r.refunds ?? '0',
          fileRows: 1,
        })),
      }),
    )
    expect(sent.received).toBe(input.rows.length)
    return { ...created, ...(await this.importOf(id, person)) }
  }

  async importOf(id: string, person: Person = this.owner): Promise<SaleImportDto> {
    return ok(await this.as<{ data: SaleImportDto }>(person, 'saleImport.get', { id })).data
  }

  async match(id: string, answers: object[], person: Person = this.owner) {
    return ok(await this.as<{ data: SaleImportDto }>(person, 'saleImport.match', { id, answers }))
      .data
  }

  async finalize(draft: SaleImportDto, person: Person = this.owner): Promise<SaleImportDto> {
    const fresh = await this.importOf(draft.id, person)
    return ok(
      await this.as<{ data: SaleImportDto }>(person, 'saleImport.post', {
        id: draft.id,
        version: fresh.version,
      }),
    ).data
  }

  async statement(input: object): Promise<ChannelStatementDto> {
    return ok(
      await this.run<{ data: ChannelStatementDto }>('channelStatement.create', {
        id: newId(),
        ...input,
      }),
    ).data
  }

  async postStatement(statement: ChannelStatementDto) {
    return this.run<{ data: ChannelStatementDto }>('channelStatement.post', {
      id: statement.id,
      version: statement.version,
    })
  }
}

describe('a café imports its POS day file', () => {
  let cafe: ImportScope
  let today: string
  let yesterday: string
  let shop: SalesChannelDto
  let latte: ProductDto
  let croissant: ProductDto

  beforeAll(async () => {
    cafe = await ImportScope.open(api, CAFE)
    today = await cafe.today()
    yesterday = shift(today, -1)
    ;({ latte } = await cafe.spanishLatte(shift(today, -10)))
    latte = await cafe.updateProduct(latte, { name: 'Spanish Latte' })
    croissant = await cafe.product({ name: 'كرواسون', defaultPrice: '9' })
    shop = (await cafe.channels()).find((c) => c.kind === 'shop')!
  }, 120_000)

  it('previews a summary: "Did you mean Spanish Latte?" for "Spanish Latte L", the croissant by its name', async () => {
    const draft = await cafe.importDraft({
      channelId: shop.id,
      file: 'pos-day-1',
      amountsIncludeVat: true,
      rows: [
        { businessDate: yesterday, name: 'Spanish Latte L', qty: '120', amount: '2268' },
        { businessDate: yesterday, name: 'كرواسون', qty: '25', amount: '236.25' },
      ],
    })
    expect(draft).toMatchObject({
      status: 'draft',
      shape: 'summary',
      amountsIncludeVat: true,
      rowCount: 2,
      rowsReceived: 2,
      totalNames: 2,
      matchedNames: 1,
      salesBeforeVat: null,
      amount: '2504.25',
    })
    expect(draft.names[0]).toMatchObject({
      name: 'Spanish Latte L',
      match: { state: 'unmatched', suggestions: [{ id: latte.id, name: 'Spanish Latte' }] },
    })
    expect(draft.names[1]).toMatchObject({
      name: 'كرواسون',
      match: { state: 'matched', via: 'name', productId: croissant.id },
    })
    expect(draft.days).toEqual([
      expect.objectContaining({ businessDate: yesterday, state: 'new', otherSales: false }),
    ])
    // Finalize is refused while a name is unmatched.
    const refused = await cafe.run('saleImport.post', { id: draft.id, version: draft.version })
    expect(codeOf(refused)).toBe('import_unmatched')
  })

  it('finalizes 120 lattes at 2,160.00 before VAT with their cost frozen on the day', async () => {
    const [draft] = (await cafe.run<ImportListDto>('saleImport.list', { status: 'draft' })).data!
      .items
    const matched = await cafe.match(draft!.id, [
      { name: 'Spanish Latte L', target: 'product', productId: latte.id },
    ])
    expect(matched.matchedNames).toBe(2)
    expect(matched.salesBeforeVat).toBe('2385')
    const posted = await cafe.finalize(matched)
    expect(posted).toMatchObject({ status: 'posted', names: [], rowsReceived: 0 })
    expect(posted.days).toHaveLength(1)
    const [day] = posted.days
    expect(day).toMatchObject({ businessDate: yesterday, state: 'posted', amount: '2385' })
    const sale = await cafe.sale(day!.saleIds[0]!)
    expect(sale).toMatchObject({
      source: 'import',
      importId: posted.id,
      status: 'posted',
      netTotal: '2385',
      vatTotal: '119.25',
      total: '2504.25',
    })
    const latteLine = sale.lines.find((l) => l.productId === latte.id)!
    expect(latteLine).toMatchObject({ qty: '120', net: '2160', priceIncludesVat: true })
    // 120 lattes of the recipe at each material's average as of the day (3.002034632035 a cup, shown).
    expect(latteLine.cost).toBe('360.244155844156')
    // An imported sale is reversed through its import, never on its own.
    expect(codeOf(await cafe.run('sale.reverse', { id: sale.id }))).toBe('validation')
  })

  it('remembers the answer: the next file matches "Spanish Latte L" by it', async () => {
    const draft = await cafe.importDraft({
      channelId: shop.id,
      file: 'pos-day-2',
      amountsIncludeVat: true,
      rows: [
        { businessDate: shift(today, -2), name: 'spanish latte l', qty: '2', amount: '37.80' },
      ],
    })
    expect(draft.names[0]!.match).toMatchObject({
      state: 'matched',
      via: 'alias',
      productId: latte.id,
    })
    const discarded = await cafe.run('saleImport.discard', { id: draft.id, version: draft.version })
    expect(codeOf(discarded)).toBeUndefined()
  })

  it('keeps no file and no customer: no Storage object, and a column sent by mistake never stays', async () => {
    const counts = async () =>
      (
        await api.admin<{ objects: number; uploads: number }[]>`
          select (select count(*)::int from storage.objects
                   where name like ${`${cafe.id}/%`}) as objects,
                 (select count(*)::int from app.file_uploads
                   where business_id = ${cafe.id}) as uploads`
      )[0]!
    const before = await counts()
    const day = shift(today, -5)
    const id = newId()
    ok(
      await cafe.run('saleImport.create', {
        id,
        channelId: shop.id,
        fileName: 'pos-with-customers.csv',
        fileHash: hashOf(`customers ${tag()}`),
        fingerprint: hashOf('layout summary'),
        shape: 'summary',
        periodFrom: day,
        periodTo: day,
        mapping: SUMMARY_MAPPING,
        amountsIncludeVat: true,
        rowsRead: 1,
        rowsLeftOut: 0,
        rowCount: 1,
        customer: 'Fatima Al Mansoori',
      }),
    )
    ok(
      await cafe.run('saleImport.addRows', {
        id,
        rows: [
          {
            position: 0,
            businessDate: day,
            name: 'Spanish Latte L',
            qty: '1',
            amount: '18.90',
            fileRows: 1,
            customer: 'Fatima Al Mansoori',
            phone: '0501234567',
          },
        ],
      }),
    )
    const staged = await api.admin<{ row: string }[]>`
      select to_jsonb(r)::text as row from app.sale_import_rows r where r.import_id = ${id}`
    expect(staged).toHaveLength(1)
    expect(staged[0]!.row).not.toMatch(/Fatima|0501234567/)
    const posted = await cafe.finalize(await cafe.importOf(id))
    expect(posted.status).toBe('posted')
    const kept = await api.admin<{ hits: number }[]>`
      select (select count(*)::int from app.sale_imports i
               where i.business_id = ${cafe.id} and to_jsonb(i)::text ~ 'Fatima|0501234567')
           + (select count(*)::int from app.audit_log a
               where a.business_id = ${cafe.id} and a.changes::text ~ 'Fatima|0501234567') as hits`
    expect(kept[0]!.hits).toBe(0)
    expect(await counts()).toEqual(before)
    // Taken back, so the café's own file is the latest finalized import again.
    ok(await cafe.run('saleImport.reverse', { id }))
  })

  it('refuses the same file twice, and takes it again once its import is reversed', async () => {
    const again = await cafe.run('saleImport.create', {
      id: newId(),
      channelId: shop.id,
      fileName: 'pos-day-1 (copy).csv',
      fileHash: hashOf('pos-day-1'),
      fingerprint: hashOf('layout summary'),
      shape: 'summary',
      periodFrom: yesterday,
      periodTo: yesterday,
      mapping: SUMMARY_MAPPING,
      amountsIncludeVat: true,
      rowsRead: 2,
      rowsLeftOut: 0,
      rowCount: 2,
    })
    expect(codeOf(again)).toBe('already_imported')
    const [posted] = (await cafe.run<ImportListDto>('saleImport.list', { status: 'posted' })).data!
      .items
    const reversed = ok(
      await cafe.run<{ data: SaleImportDto }>('saleImport.reverse', { id: posted!.id }),
    ).data
    expect(reversed.status).toBe('reversed')
    expect(reversed.days[0]).toMatchObject({ state: 'reversed' })
    const redo = await cafe.importDraft({
      channelId: shop.id,
      file: 'pos-day-1',
      amountsIncludeVat: true,
      rows: [{ businessDate: yesterday, name: 'Spanish Latte L', qty: '120', amount: '2268' }],
    })
    expect(redo.matchedNames).toBe(1)
    expect((await cafe.finalize(redo)).status).toBe('posted')
  })

  it('skips the days already imported by default, and replaces them on request', async () => {
    const day = shift(today, -3)
    const first = await cafe.importDraft({
      channelId: shop.id,
      shape: 'lines',
      file: 'week-a',
      rows: [
        { businessDate: shift(day, -1), name: 'Spanish Latte', qty: '10', amount: '180' },
        { businessDate: day, name: 'Spanish Latte', qty: '5', amount: '90' },
      ],
    })
    await cafe.finalize(first)
    const second = await cafe.importDraft({
      channelId: shop.id,
      shape: 'lines',
      file: 'week-b',
      rows: [
        { businessDate: day, name: 'Spanish Latte', qty: '6', amount: '108' },
        { businessDate: shift(day, 1), name: 'Spanish Latte', qty: '7', amount: '126' },
      ],
    })
    expect(second.days.map((d) => [d.businessDate, d.state])).toEqual([
      [day, 'imported'],
      [shift(day, 1), 'new'],
    ])
    expect(second.days[0]!.importedBy).toMatchObject({ id: first.id, fileName: 'week-a.csv' })
    const skipped = await cafe.finalize(second)
    expect(skipped.days.map((d) => [d.businessDate, d.state])).toEqual([
      [day, 'skipped'],
      [shift(day, 1), 'posted'],
    ])
    const third = await cafe.importDraft({
      channelId: shop.id,
      shape: 'lines',
      file: 'week-c',
      rows: [{ businessDate: day, name: 'Spanish Latte', qty: '6', amount: '108' }],
    })
    ok(
      await cafe.run('saleImport.setOverlap', {
        id: third.id,
        version: third.version,
        overlap: 'replace',
      }),
    )
    const replaced = await cafe.finalize(third)
    expect(replaced.replacedDays).toEqual([day])
    const earlier = await cafe.importOf(first.id)
    expect(earlier.days.map((d) => [d.businessDate, d.state])).toEqual([
      [shift(day, -1), 'posted'],
      [day, 'reversed'],
    ])
  })

  it("warns about Today's sales and an import of the same channel and day, both ways", async () => {
    const day = shift(today, -5)
    await cafe.sell({
      source: 'day_sheet',
      businessDate: day,
      channelId: shop.id,
      lines: [{ kind: 'item', id: newId(), productId: latte.id, qty: '3', unitPrice: '18' }],
    })
    const draft = await cafe.importDraft({
      channelId: shop.id,
      shape: 'lines',
      file: 'day-with-sheet',
      rows: [{ businessDate: day, name: 'Spanish Latte', qty: '4', amount: '72' }],
    })
    expect(draft.days[0]).toMatchObject({ otherSales: true, state: 'new' })
    await cafe.finalize(draft)
    const sheet = await cafe.sheet({ businessDate: day, channelId: shop.id })
    expect(sheet.imported).toBe(true)
    const other = await cafe.sheet({ businessDate: shift(day, -1), channelId: shop.id })
    expect(other.imported).toBe(false)
  })
})

describe('app fees by channel: a marketplace file with a fee column and statements', () => {
  let cafe: ImportScope
  let talabat: SalesChannelDto
  let latte: ProductDto
  let month: string
  let last: string

  beforeAll(async () => {
    cafe = await ImportScope.open(api, CAFE)
    const today = await cafe.today()
    month = monthOf(today)
    last = addMonths(month, -1)
    latte = await cafe.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
    talabat = await cafe.channel({ name: 'Talabat', kind: 'delivery_app', feePercent: '20' })
  }, 120_000)

  it("a file's fee column becomes the channel's statement: Talabat's 18 % in place of its 20 %", async () => {
    const from = dayOf(last, 1)
    const to = lastOf(last)
    const draft = await cafe.importDraft({
      channelId: talabat.id,
      shape: 'lines',
      mapping: LINES_MAPPING,
      file: 'talabat-last-month',
      feesTotal: '1800',
      rows: [
        { businessDate: from, name: latte.name, qty: '300', amount: '5400', code: 'LAT' },
        { businessDate: to, name: latte.name, qty: '255', amount: '4600', code: 'LAT' },
      ],
    })
    expect(draft.feesTotal).toBe('1800')
    const posted = await cafe.finalize(draft)
    expect(posted.statementId).not.toBeNull()
    const statement = ok(
      await cafe.run<{ data: ChannelStatementDto }>('channelStatement.get', {
        id: posted.statementId,
      }),
    ).data
    expect(statement).toMatchObject({
      status: 'posted',
      periodFrom: from,
      periodTo: to,
      commission: '1800',
      fees: '1800',
      sales: '10000',
      importId: posted.id,
    })
    const summary = await cafe.summary({ from, to, groupBy: 'channel' })
    const group = summary.groups.find((g) => g.key === talabat.id)!
    expect(group.itemSales).toBe('10000')
    // 1,800 ÷ 10,000 = 18 % of each sale's net, never the 20 % commission (2,000).
    expect(group.fees).toBe('1800')
    // A statement covering the same days again is refused.
    const twice = await cafe.statement({
      channelId: talabat.id,
      periodFrom: dayOf(last, 10),
      periodTo: dayOf(last, 12),
      commission: '50',
    })
    expect(codeOf(await cafe.postStatement(twice))).toBe('statement_overlap')
  })

  it('a statement over two months counts in each by its days', async () => {
    const channel = await cafe.channel({ name: `Keeta ${tag()}`, kind: 'delivery_app' })
    const before = addMonths(last, -1)
    const from = dayOf(before, 16)
    const to = dayOf(last, 15)
    const rows = [{ businessDate: dayOf(before, 20), name: latte.name, qty: '10', amount: '180' }]
    await cafe.finalize(
      await cafe.importDraft({ channelId: channel.id, shape: 'lines', file: `a-${tag()}`, rows }),
    )
    await cafe.finalize(
      await cafe.importDraft({
        channelId: channel.id,
        shape: 'lines',
        file: `b-${tag()}`,
        rows: [{ businessDate: dayOf(last, 5), name: latte.name, qty: '10', amount: '180' }],
      }),
    )
    const statement = await cafe.statement({
      channelId: channel.id,
      periodFrom: from,
      periodTo: to,
      commission: '2400',
      paymentFees: '80',
    })
    expect(statement.fees).toBe('2480')
    ok(await cafe.postStatement(statement))
    const parts = statementParts({ from, to, fees: '2480' })
    expect(parts.map((p) => p.days)).toEqual([daysIn(before) - 15, 15])
    for (const part of parts) {
      const summary = await cafe.summary({
        from: dayOf(part.month, 1),
        to: lastOf(part.month),
        groupBy: 'channel',
      })
      const group = summary.groups.find((g) => g.key === channel.id)!
      expect(group.fees).toBe(part.fees)
    }
  })

  it('refuses a statement in closed books, and reverses one in open books', async () => {
    const draft = await cafe.statement({
      channelId: talabat.id,
      periodFrom: dayOf(month, 1),
      periodTo: dayOf(month, 1),
      commission: '10',
    })
    ok(await cafe.run('books.close', { closedThrough: dayOf(month, 1) }))
    expect(codeOf(await cafe.postStatement(draft))).toBe('books_closed')
    ok(await cafe.run('books.close', { closedThrough: null }))
    const posted = ok(await cafe.postStatement(draft)).data
    expect(posted.status).toBe('posted')
    const reversed = ok(
      await cafe.run<{ data: ChannelStatementDto }>('channelStatement.reverse', { id: posted.id }),
    ).data
    expect(reversed.status).toBe('reversed')
  })

  it('withholds statements from a member without the costs switch', async () => {
    const sales = await api.member(cafe, 'sales')
    const listed = await cafe.as(sales, 'channelStatement.list', { channelId: talabat.id })
    expect(codeOf(listed)).toBe('forbidden')
    const imported = await cafe.as(sales, 'saleImport.list', {})
    expect(codeOf(imported)).toBe('forbidden')
  })
})

describe('the import key', () => {
  it('needs entering and finalizing sales, and the Manager has it', async () => {
    const cafe = await ImportScope.open(api, CAFE)
    const manager = await api.member(cafe, 'manager')
    expect(codeOf(await cafe.as(manager, 'saleImport.list', {}))).toBeUndefined()
    const employee = await api.member(cafe, 'employee')
    expect(codeOf(await cafe.as(employee, 'saleImport.list', {}))).toBe('forbidden')
  })
})

describe('retail: a size first sold in a later file (D-262)', () => {
  let shop: ImportScope
  let channelId: string
  let today: string

  beforeAll(async () => {
    shop = await ImportScope.open(api, CAFE)
    channelId = (await shop.channels()).find((c) => c.kind === 'shop')!.id
    today = await shop.today()
  }, 120_000)

  /** The products the lines of an import's finalized sales are on. */
  const productsOf = async (posted: SaleImportDto) =>
    (
      await api.admin<{ product_id: string }[]>`
        select l.product_id from app.sale_lines l
         where l.business_id = ${shop.id}
           and l.sale_id = any(${posted.days.flatMap((d) => d.saleIds)}::uuid[])
         order by l.position`
    ).map((l) => l.product_id)

  it('waits for its own answer, offers the first size, and is added as new under its code', async () => {
    const t = tag()
    const name = `Juice ${t}`
    const [j250, j500] = [`J-250-${t}`, `J-500-${t}`]
    // File 1 sells "Juice" only as J-250, added as new: one code in the file, the plain name.
    const first = await shop.importDraft({
      channelId,
      shape: 'lines',
      mapping: LINES_MAPPING,
      rows: [{ businessDate: shift(today, -3), name, code: j250, qty: '4', amount: '20' }],
    })
    const small = newId()
    const answered = await shop.match(first.id, [
      { name, code: j250, target: 'new', productId: small },
    ])
    expect(answered.names[0]!.match).toMatchObject({ productId: small, productName: name })
    expect(await productsOf(await shop.finalize(answered))).toEqual([small])

    // File 2 sells "Juice" only as J-500: never put on the 250 ml product by its name.
    const second = await shop.importDraft({
      channelId,
      shape: 'lines',
      mapping: LINES_MAPPING,
      rows: [{ businessDate: shift(today, -2), name, code: j500, qty: '2', amount: '16' }],
    })
    expect(second.matchedNames).toBe(0)
    expect(second.names[0]).toMatchObject({
      code: j500,
      match: { state: 'unmatched', suggestions: [{ id: small, name }] },
    })
    const refused = await shop.run('saleImport.post', { id: second.id, version: second.version })
    expect(codeOf(refused)).toBe('import_unmatched')
    // "Add as new" makes it, named with its code: its plain name is the first size's.
    const large = newId()
    const added = await shop.match(second.id, [
      { name, code: j500, target: 'new', productId: large },
    ])
    expect(added.names[0]!.match).toMatchObject({
      state: 'matched',
      productId: large,
      productName: `${name} · ${j500}`,
    })
    expect(await productsOf(await shop.finalize(added))).toEqual([large])

    // From then on each code finds its own product.
    const third = await shop.importDraft({
      channelId,
      shape: 'lines',
      mapping: LINES_MAPPING,
      rows: [
        { businessDate: shift(today, -1), name, code: j500, qty: '1', amount: '8' },
        { businessDate: shift(today, -1), name, code: j250, qty: '1', amount: '5' },
      ],
    })
    expect(third.matchedNames).toBe(2)
    expect(await productsOf(await shop.finalize(third))).toEqual([large, small])
  })
})

describe('staged rows as a file sends them (D-262)', () => {
  let shop: ImportScope
  let channelId: string
  let today: string

  beforeAll(async () => {
    shop = await ImportScope.open(api, CAFE)
    channelId = (await shop.channels()).find((c) => c.kind === 'shop')!.id
    today = await shop.today()
  }, 120_000)

  it('keeps every character of names and codes, and audits each statement by what its rows come to', async () => {
    const t = tag()
    const karak = await shop.product({ name: `Karak Tea ${t}`, defaultPrice: '3' })
    const day = shift(today, -4)
    const odd = [
      `Tea "Special" ${t}`,
      `C:\\Menu\\Item\\ ${t}`,
      `Cake, slice {big} ${t}`,
      'NULL',
      `شاي "كرك" ${t}`,
    ]
    const charge = `Service, "VIP" \\ 10% ${t}`
    const draft = await shop.importDraft({
      channelId,
      shape: 'lines',
      mapping: LINES_MAPPING,
      rows: [
        // Read by its name (no answer saved): this spelling is the staged row's alone.
        { businessDate: day, name: `KARAK TEA ${t}`, qty: '2', amount: '6' },
        ...odd.map((name, i) => ({
          businessDate: day,
          name,
          code: i === 0 ? `A"1\\b${t}` : null,
          qty: '1',
          amount: '1',
        })),
        { businessDate: day, name: charge, qty: '1', amount: '2.50' },
      ],
    })
    const sent = draft.names.map((n) => [n.name, n.code])
    expect(sent).toEqual(
      expect.arrayContaining([
        [`KARAK TEA ${t}`, null],
        [odd[0], `A"1\\b${t}`],
        ...odd.slice(1).map((name) => [name, null]),
        [charge, null],
      ]),
    )
    expect(draft.names).toHaveLength(odd.length + 2)
    expect(draft.names.find((n) => n.name === `KARAK TEA ${t}`)!.match).toMatchObject({
      via: 'name',
      productId: karak.id,
    })
    const matched = await shop.match(draft.id, [
      ...odd.map((name, i) => ({ name, code: i === 0 ? `A"1\\b${t}` : null, target: 'skip' })),
      { name: charge, target: 'charge' },
    ])
    const posted = await shop.finalize(matched)
    expect(posted.status).toBe('posted')
    // The service charge's line is named as the file names it.
    const lines = await api.admin<{ kind: string; description: string }[]>`
      select l.kind, l.description from app.sale_lines l
       where l.business_id = ${shop.id} and l.sale_id = any(${posted.days[0]!.saleIds}::uuid[])
       order by l.position`
    expect(lines).toEqual([
      { kind: 'item', description: karak.name },
      { kind: 'charge', description: charge },
    ])

    // The staged rows' audit: one row per statement and import (sent, then cleared on finalizing),
    // with what they came to; never a row of each, so the file's own spelling stays out of the log.
    const audit = await api.admin<{ action: string; entity_id: string; changes: object }[]>`
      select action, entity_id, changes from app.audit_log
       where business_id = ${shop.id} and entity = 'sale_import_rows'
       order by id`
    const summary = {
      import_id: draft.id,
      rows: odd.length + 2,
      positions: [0, odd.length + 1],
      days: [day, day],
      qty: odd.length + 3,
      amount: odd.length + 8.5,
      refunds: 0,
      file_rows: odd.length + 2,
    }
    expect(audit).toEqual([
      { action: 'insert', entity_id: draft.id, changes: { after: summary } },
      { action: 'delete', entity_id: draft.id, changes: { before: summary } },
    ])
    const leaked = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where business_id = ${shop.id} and changes::text like ${`%KARAK TEA ${t}%`}`
    expect(leaked[0]!.n).toBe(0)
  })
})
