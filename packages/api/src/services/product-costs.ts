import type {
  MonthCostsDto,
  productCostGetInput,
  ProductCostBreakdownDto,
  ProductCostLineDto,
  productCostListInput,
  ProductCostListDto,
  ProductCostRowDto,
  ProductCostSettingsDto,
  SalePriceDto,
  UnitCostDto,
  updateProductCostSettingsInput,
} from '@bizcost/contracts'
import { businesses, type Tx } from '@bizcost/db'
import {
  addMonths,
  can,
  compareDecimal,
  costCompleteFor,
  costOfQty,
  costPool,
  costRatio,
  dimensionOf,
  firstDayOf,
  fitsCurrency,
  isCurrencyCode,
  monthCostsSoFar,
  monthOf,
  PURCHASE_AVERAGE_DAYS,
  priceBeforeVat,
  productCost,
  rollUpRecipe,
  saleVatRate,
  STANDARD_UNITS,
  sumDecimals,
  unitCostOf,
  type BusinessMonth,
  type CostPool,
  type MaterialsPart,
  type OwnerTimePart,
  type ProductCost,
  type ProductType,
  type RunningCostsPart,
  type SalePrice,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { eq, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertQueryable, passes, type QueryField } from '../trpc'
import { containsPattern } from './catalog'
import { averageBasisOf, costRecordsOf, lastPurchaseOf } from './material-costs'
import {
  costInputsOf,
  costsOn,
  lastDayOf,
  profitEnvOf,
  ratesOf,
  runningCostsEntered,
  type CostInputs,
} from './real-profit'
import { basesOf, findRecipe, linesOf, materialCostsOf, type ProductMaterialCost } from './recipes'
import { fillSaleTimeCosts } from './sale-costs'
import { uuidArray } from './stock'

// Product costs (ROADMAP.md M2 Step 6; D-115, D-119, D-121, D-178, D-202): what one unit sold of each
// product or service costs, line by line, and its margin. Module `cost_engine` (and `products`; the
// router checks them and the keys). Worked out on read, nothing stored: the sums in SQL from the cost
// rows (the purchase ledger, recipes, running costs, expenses, the business's settings), each
// division once in the domain (productCost, costPool), never rounded to the currency.
//
//   - Materials: its recipe at the materials' averages (the D-115 basis) ÷ what it makes, or, bought
//     ready to sell, its material's average (materialCostsOf in services/recipes.ts, the same as
//     product.costs). With the Materials module off there is no materials line.
//   - Running costs, by its price (D-202, the owner's decision of 2026-09-30, which replaces D-116's
//     share of the material cost): its price before VAT × the month's costs ÷ the month's item sales,
//     at the rate the running month's sales carry (M3 Step 3, Q6: the last full month that sold; a
//     first month's costs so far after 7 days of sales; services/real-profit.ts). The costs (costPool):
//     the running costs for the days they ran (Running Costs on), the finalized expenses that belong
//     to the month at what they cost the business (Expenses on), counted once (a running cost's own
//     bills replace its regular amount, extras on top, D-216; a channel's fees and delivery never, Q8),
//     and the materials no product uses (Purchases on, Q13 A). Without sales every share is "awaiting
//     sales", and "no price" without a price (real profit still carries its share at the price it was
//     sold for). With both modules off there is no share.
//   - The owner's time (D-119), only without a team: minutes for one unit × hourly rate ÷ 60.
//   - The margin, on the price before VAT (VAT is never revenue; D-114, D-121).
//
// Sensitive: costs `cost`, a material's last purchase price `supplier_price`, margins
// `profit_margin` (the redact middleware removes them; the three are visible only together, D-187).
// Sorting or filtering on a hidden one is FORBIDDEN before anything is read. The month's costs are
// withheld here (null, `amountsShown: false`) from a member who may not see running costs and
// expenses themselves (D-202). The settings (the hourly rate) are written only by a member who sees
// what they write.

type ListInput = z.output<typeof productCostListInput>
type GetInput = z.output<typeof productCostGetInput>
type SettingsInput = z.output<typeof updateProductCostSettingsInput>

/** The business's day and what its costs are worked out with. */
interface Costing {
  readonly today: string
  readonly currency: string
  readonly vatRegistered: boolean
  /** businesses.owner_hourly_rate (null: not set). */
  readonly hourlyRate: string | null
}

async function costingOf(tx: Tx, businessId: string): Promise<Costing> {
  const [row] = (await tx.execute(sql`
    select (now() at time zone b.timezone)::date::text as today, trim(b.currency) as currency,
           b.vat_registered, trim_scale(b.owner_hourly_rate)::text as hourly_rate
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as {
    today: string
    currency: string
    vat_registered: boolean
    hourly_rate: string | null
  }[]
  if (!row) throw new AppError('forbidden')
  return {
    today: row.today,
    currency: row.currency,
    vatRegistered: row.vat_registered,
    hourlyRate: row.hourly_rate,
  }
}

/** The first day of the 90 days the materials' average covers (D-115). */
function averageFromOf(today: string): string {
  const day = new Date(`${today}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - (PURCHASE_AVERAGE_DAYS - 1))
  return day.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------------------------------
// The month's costs (D-202) and the rate the running month's sales carry (M3 Step 3, Q6)
// ---------------------------------------------------------------------------------------------------

interface MonthCosts {
  readonly part: RunningCostsPart
  readonly dto: MonthCostsDto
}

/**
 * Whether the member may see the business's costs of a month (D-202): costs visible (with supplier
 * prices and margins, D-187), and running costs and expenses themselves (their keys, as the Owner
 * does whether or not the modules are on). An expense's amounts are supplier prices (D-165).
 */
function mayReadMonthCosts(ctx: BusinessCtx): boolean {
  return (
    ctx.access.visibleCategories.has('cost') &&
    ctx.access.visibleCategories.has('supplier_price') &&
    can(ctx.access.effective, 'running_costs.items.view') &&
    can(ctx.access.effective, 'expenses.documents.view')
  )
}

type PoolLines = CostPool['categories'][number]['lines']
type ShownLine = Omit<PoolLines[number], 'amount'> & { amount: string }

/** The costs shown with the rate: a whole month's pool, or the days a rate is worked out over. */
interface ShownCosts {
  readonly month: BusinessMonth
  readonly from: string | null
  readonly to: string | null
  readonly total: string
  readonly categories: readonly { categoryId: string; amount: string; lines: ShownLine[] }[]
  readonly materials: readonly { materialId: string; amount: string }[]
}

/** A whole month's costs (costPool), as shown. */
function wholeMonth(month: BusinessMonth, inputs: CostInputs): ShownCosts {
  const pool = costPool(month, inputs.running, inputs.expenses, inputs.materials)
  return {
    month,
    from: null,
    to: null,
    total: pool.total,
    categories: pool.categories.map((c) => ({
      categoryId: c.categoryId,
      amount: c.amount,
      lines: c.lines.map((line) => ({ ...line })),
    })),
    materials: (pool.materials?.lines ?? []).map((m) => ({
      materialId: m.materialId,
      amount: m.amount,
    })),
  }
}

/**
 * The costs of the days `from` … `to` (a rate worked out so far, Q6; a short first month's days run
 * on into the next month): month by month (monthCostsSoFar), each line's amount for those days with
 * the rest of what its month's pool says of it, added where they span two months.
 */
function daysOfMonths(from: string, to: string, inputs: CostInputs): ShownCosts {
  const categories = new Map<string, { amount: string; lines: Map<string, ShownLine> }>()
  const materials = new Map<string, string>()
  let total = '0'
  for (let month = monthOf(from); month <= monthOf(to); month = addMonths(month, 1)) {
    const dayFrom = month === monthOf(from) ? from : firstDayOf(month)
    const dayTo = month === monthOf(to) ? to : lastDayOf(month)
    const pool = costPool(month, inputs.running, inputs.expenses, inputs.materials)
    const soFar = monthCostsSoFar(
      month,
      dayFrom,
      dayTo,
      inputs.running,
      inputs.expenses,
      inputs.materials,
    )
    total = sumDecimals([total, soFar.total])
    for (const [index, category] of soFar.categories.entries()) {
      const poolCategory = pool.categories[index]!
      const entry = categories.get(category.categoryId) ?? { amount: '0', lines: new Map() }
      entry.amount = sumDecimals([entry.amount, category.amount])
      for (const [at, line] of category.lines.entries()) {
        const key = `${line.kind}|${line.runningCostId ?? ''}`
        const before = entry.lines.get(key)
        entry.lines.set(key, {
          ...poolCategory.lines[at]!,
          amount: sumDecimals([before?.amount ?? '0', line.amount]),
        })
      }
      categories.set(category.categoryId, entry)
    }
    for (const line of soFar.materials?.lines ?? []) {
      materials.set(
        line.materialId,
        sumDecimals([materials.get(line.materialId) ?? '0', line.amount]),
      )
    }
  }
  return {
    month: monthOf(to),
    from,
    to,
    total,
    categories: [...categories].map(([categoryId, c]) => ({
      categoryId,
      amount: c.amount,
      lines: [...c.lines.values()],
    })),
    materials: [...materials].map(([materialId, amount]) => ({ materialId, amount })),
  }
}

/** The largest first, then by name (the unnamed after a named one of the same amount), then by id. */
function largestFirst(
  a: { amount: string; name: string | null; id: string },
  b: { amount: string; name: string | null; id: string },
): number {
  return (
    compareDecimal(b.amount, a.amount) ||
    (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) ||
    (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase()) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/** The material names of the materials no product uses (Q13 A) shown. */
async function materialNamesOf(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = (await tx.execute(sql`
    select m.id, m.name from app.materials m
     where m.business_id = ${businessId} and m.id = any(${uuidArray([...ids])})
  `)) as unknown as { id: string; name: string }[]
  return new Map(rows.map((r) => [r.id, r.name] as const))
}

/**
 * How running costs reach what the business sells, and the costs behind it (D-202, D-203, D-216, M3
 * Step 3): the rate the running month's sales carry (Q6: the last full month that sold, `last_month`;
 * a first month's costs from its first sale ÷ its sales so far, `so_far`, shown after 7 days of
 * sales; awaiting sales without any), which every product's share is worked out at (its price before
 * VAT × costs ÷ item sales, at the price it is sold for in real profit). Sales count only while Sales
 * is served (services/real-profit.ts): a released business keeps "awaiting sales" (the plan's D3). The
 * costs shown: those the rate divides (a month's pool, or its days so far), or without sales the last
 * full calendar month's. The amounts are withheld from the DTO (never from what the costs are worked
 * out with) unless mayReadMonthCosts, the item sales with them (costs ÷ rate gives them: D-250).
 */
async function monthCostsOf(tx: Tx, ctx: BusinessCtx, costing: Costing): Promise<MonthCosts> {
  const env = await profitEnvOf(tx, ctx)
  const current = monthOf(costing.today)
  const lastFull = addMonths(current, -1)
  const amountsShown = mayReadMonthCosts(ctx)
  const entered = await runningCostsEntered(tx, ctx.businessId)
  if (!costsOn(env)) {
    return {
      part: { state: 'off' },
      dto: {
        state: 'off',
        basis: null,
        runningCostsEntered: entered,
        month: lastFull,
        from: null,
        to: null,
        showsOn: null,
        rate: null,
        amountsShown,
        total: null,
        sales: null,
        categories: null,
        materials: null,
      },
    }
  }
  const rate = (await ratesOf(tx, env, [current])).get(current)!
  const source = rate.source
  const sourceSpan =
    source === null
      ? { from: lastFull, to: lastFull }
      : source.from === null || source.to === null
        ? { from: source.month, to: source.month }
        : { from: monthOf(source.from), to: monthOf(source.to) }
  const inputs = await costInputsOf(tx, env, sourceSpan.from, sourceSpan.to)
  const shown =
    source === null
      ? wholeMonth(lastFull, inputs)
      : source.from === null || source.to === null
        ? wholeMonth(source.month, inputs)
        : daysOfMonths(source.from, source.to, inputs)
  const part: RunningCostsPart =
    rate.rate.state === 'before_running_costs'
      ? { state: 'before_running_costs' }
      : { state: 'on', costs: rate.rate.costs ?? shown.total, sales: rate.rate.sales }
  let categories: MonthCostsDto['categories'] = null
  let materials: MonthCostsDto['materials'] = null
  if (amountsShown) {
    const names = new Map(
      [...inputs.running, ...inputs.expenses].map((r) => [r.categoryId, r.categoryName] as const),
    )
    const runningNames = new Map(inputs.running.map((r) => [r.id, r.name] as const))
    categories = shown.categories
      .map((c) => ({
        categoryId: c.categoryId,
        name: names.get(c.categoryId) ?? '',
        amount: c.amount,
        lines: c.lines
          .map((line) => ({
            kind: line.kind,
            runningCostId: line.runningCostId,
            name: line.runningCostId === null ? null : (runningNames.get(line.runningCostId) ?? ''),
            source: line.source,
            amount: line.amount,
            regular: line.regular,
            period: line.period,
            takenBack: line.takenBack,
          }))
          .sort((a, b) =>
            largestFirst(
              { amount: a.amount, name: a.name, id: a.runningCostId ?? '' },
              { amount: b.amount, name: b.name, id: b.runningCostId ?? '' },
            ),
          ),
      }))
      .sort((a, b) =>
        largestFirst(
          { amount: a.amount, name: a.name, id: a.categoryId },
          { amount: b.amount, name: b.name, id: b.categoryId },
        ),
      )
    // Each material's name and amount show what was paid for it: also purchases.documents.view.
    if (shown.materials.length > 0 && can(ctx.access.effective, 'purchases.documents.view')) {
      const materialNames = await materialNamesOf(
        tx,
        ctx.businessId,
        shown.materials.map((m) => m.materialId),
      )
      materials = shown.materials
        .map((m) => ({
          materialId: m.materialId,
          name: materialNames.get(m.materialId) ?? '',
          amount: m.amount,
        }))
        .sort((a, b) =>
          largestFirst(
            { amount: a.amount, name: a.name, id: a.materialId },
            { amount: b.amount, name: b.name, id: b.materialId },
          ),
        )
    }
  }
  // The item sales the rate divides go with the costs it divides (D-250): costs ÷ rate gives them, and
  // the rate is any share ÷ its price (D-203), so whoever sees the month's costs sees them too, every
  // branch and every sale (an accepted residue, as Q11's rate × sales = costs).
  return {
    part,
    dto: {
      state: rate.rate.state,
      basis: source?.basis ?? null,
      runningCostsEntered: entered,
      month: shown.month,
      from: shown.from,
      to: shown.to,
      showsOn: rate.showsOn,
      rate: rate.rate.rate,
      amountsShown,
      total: amountsShown ? shown.total : null,
      sales: amountsShown ? rate.rate.sales : null,
      categories,
      materials,
    },
  }
}

/** A product or service as its cost needs it. */
interface ProductRow extends Record<string, unknown> {
  id: string
  name: string
  type: ProductType
  unit: StandardUnit
  default_price: string | null
  vat_category: VatCategory
  price_includes_vat: boolean
  resale_material_id: string | null
  owner_minutes: string | null
  archived: boolean
}

const productColumns = sql`
  p.id, p.name, p.type, p.unit, trim_scale(p.default_price)::text as default_price, p.vat_category,
  p.price_includes_vat, p.resale_material_id, trim_scale(p.owner_minutes)::text as owner_minutes,
  p.archived_at is not null as archived`

function saleOf(product: ProductRow, costing: Costing): SalePrice {
  return {
    price: product.default_price,
    priceIncludesVat: product.price_includes_vat,
    vatCategory: product.vat_category,
    vatRegistered: costing.vatRegistered,
  }
}

function salePriceDtoOf(sale: SalePrice): SalePriceDto {
  const stripped = sale.vatRegistered && sale.priceIncludesVat
  return {
    defaultPrice: sale.price,
    includesVat: sale.priceIncludesVat,
    vatRate: stripped ? saleVatRate(sale.vatCategory) : '0',
    beforeVat: priceBeforeVat(sale),
  }
}

function ownerTimeOf(ctx: BusinessCtx, product: ProductRow, costing: Costing): OwnerTimePart {
  return ctx.access.capabilities.has_team
    ? { state: 'team' }
    : { state: 'solo', minutes: product.owner_minutes, hourlyRate: costing.hourlyRate }
}

/** The cost's DTO, `complete` as the screens and counts say it (costCompleteFor, D-203). */
function unitCostDtoOf(cost: ProductCost, time: OwnerTimePart, complete: boolean): UnitCostDto {
  return {
    materials: cost.materials,
    runningCosts: { state: cost.runningCosts.state, amount: cost.runningCosts.share },
    ownerTime: {
      state: cost.ownerTime.state,
      minutes: time.state === 'solo' ? time.minutes : null,
      amount: cost.ownerTime.amount,
    },
    total: cost.total,
    beforeRunningCosts: cost.beforeRunningCosts,
    tooLarge: cost.tooLarge,
    reasons: [...cost.reasons],
    complete,
  }
}

function ownerTimeSettingOf(ctx: BusinessCtx, costing: Costing) {
  return { applies: !ctx.access.capabilities.has_team, hourlyRate: costing.hourlyRate }
}

// ---------------------------------------------------------------------------------------------------
// productCost.list
// ---------------------------------------------------------------------------------------------------

/** What a sort or filter reads, and the sensitivity category it needs visible. */
const SORT_FIELDS: Readonly<Record<ListInput['sort'], QueryField>> = {
  name: { name: 'name' },
  price: { name: 'price' },
  cost: { name: 'cost', category: 'cost' },
  margin: { name: 'margin', category: 'profit_margin' },
  margin_percent: { name: 'margin_percent', category: 'profit_margin' },
}
const FILTER_FIELDS: Readonly<Record<NonNullable<ListInput['filter']>, QueryField>> = {
  incomplete: { name: 'incomplete', category: 'cost' },
  loss: { name: 'loss', category: 'profit_margin' },
}

const CURSOR_TAG = 'productCost'

/** The cursor of the next page: the sort, order and filter it follows, and where it starts. */
function encodeCursor(input: ListInput, offset: number): string {
  return Buffer.from(
    JSON.stringify([CURSOR_TAG, input.sort, input.order, input.filter ?? null, offset]),
    'utf8',
  ).toString('base64url')
}

/** Where the page starts; a cursor this server did not make for this sort and filter is VALIDATION. */
function offsetOf(input: ListInput): number {
  if (!input.cursor) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
  } catch {
    throw new AppError('validation', { message: 'invalid cursor' })
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 5 ||
    parsed[0] !== CURSOR_TAG ||
    parsed[1] !== input.sort ||
    parsed[2] !== input.order ||
    parsed[3] !== (input.filter ?? null) ||
    typeof parsed[4] !== 'number' ||
    !Number.isSafeInteger(parsed[4]) ||
    parsed[4] < 0
  ) {
    throw new AppError('validation', { message: 'invalid cursor' })
  }
  return parsed[4]
}

interface Costed {
  readonly product: ProductRow
  /** Its place in the database's order by name. */
  readonly sortKey: number
  readonly row: ProductCostRowDto
  readonly cost: ProductCost
  /** Complete as the screens and counts say it (costCompleteFor, D-203). */
  readonly complete: boolean
}

/** The value a row is sorted by (null: it has none, and goes last whichever the direction). */
function sortValue(costed: Costed, sort: ListInput['sort']): string | null {
  switch (sort) {
    case 'price':
      return costed.cost.priceBeforeVat
    case 'cost':
      return costed.cost.total
    case 'margin':
      return costed.cost.margin
    case 'margin_percent':
      return costed.cost.marginPercent
    case 'name':
      return null
  }
}

/**
 * `productCost.list`: every product and service matching the search (the page `limit` long), each
 * with its cost for one unit sold, line by line, and its margin; sorted by name (as the database
 * orders lower(name)), price, cost, margin or margin % (nulls last, then by name; by margin, an
 * incomplete cost's margin is only "at most", so those rows come after the complete ones either way),
 * and filtered to those incomplete or at a loss; with how many of them are incomplete (a service
 * missing only its optional materials is not, D-203), at a loss, or without the owner's minutes; and
 * the business's costs of the last full month (D-202). Sorting and filtering on costs or margins need
 * them visible (FORBIDDEN otherwise, before anything is read).
 */
export function listProductCosts(ctx: BusinessCtx, input: ListInput): Promise<ProductCostListDto> {
  return ctx.tx((tx) => listProductCostsIn(tx, ctx, input))
}

/** `productCost.list` inside the caller's transaction (also the Dashboard's cost checklist). */
export async function listProductCostsIn(
  tx: Tx,
  ctx: BusinessCtx,
  input: ListInput,
): Promise<ProductCostListDto> {
  assertQueryable(ctx, [
    SORT_FIELDS[input.sort],
    ...(input.filter ? [FILTER_FIELDS[input.filter]] : []),
  ])
  const offset = offsetOf(input)
  const businessId = ctx.businessId
  // A member who sees costs gets the counts: every product that matches is costed first. Otherwise
  // (nothing to count), by name without a filter the database pages the products and only the page
  // is costed.
  const counting = ctx.access.visibleCategories.has('cost')
  const byName = input.sort === 'name'
  const pagedInSql = byName && input.filter === undefined && !counting
  const costing = await costingOf(tx, businessId)
  const monthCosts = await monthCostsOf(tx, ctx, costing)
  const conditions: SQL[] = [sql`p.business_id = ${businessId}`, sql`p.deleted_at is null`]
  if (input.status === 'active') conditions.push(sql`p.archived_at is null`)
  if (input.status === 'archived') conditions.push(sql`p.archived_at is not null`)
  if (input.type) conditions.push(sql`p.type = ${input.type}`)
  if (input.search) conditions.push(sql`p.name ilike ${containsPattern(input.search)}`)
  const order =
    byName && input.order === 'desc' ? sql`lower(p.name) desc, p.id desc` : sql`lower(p.name), p.id`
  const page = pagedInSql ? sql`limit ${input.limit + 1} offset ${offset}` : sql``
  const products = (await tx.execute(sql`
      select ${productColumns}
        from app.products_services p
       where ${sql.join(conditions, sql` and `)}
       order by ${order}
       ${page}
    `)) as unknown as ProductRow[]
  const counted = pagedInSql ? products.slice(0, input.limit) : products

  const materials = passes(ctx, ['materials'])
    ? await materialCostsOf(
        tx,
        businessId,
        counted.map((p) => ({ id: p.id, unit: p.unit, resaleMaterialId: p.resale_material_id })),
      )
    : new Map<string, ProductMaterialCost>()

  let costed: Costed[] = counted.map((product, sortKey) => {
    const material = materials.get(product.id)
    const part: MaterialsPart = material
      ? {
          state: 'on',
          perUnit: material.cost.perUnit,
          lineCount: material.lineCount,
          unpricedLines: material.cost.unpricedLines,
          tooLarge: material.cost.tooLarge,
        }
      : { state: 'off' }
    const sale = saleOf(product, costing)
    const time = ownerTimeOf(ctx, product, costing)
    const cost = productCost({
      materials: part,
      runningCosts: monthCosts.part,
      ownerTime: time,
      sale,
    })
    const complete = costCompleteFor(product.type, cost)
    const row: ProductCostRowDto = {
      productId: product.id,
      name: product.name,
      type: product.type,
      unit: product.unit,
      kind: product.resale_material_id === null ? 'recipe' : 'resale',
      archived: product.archived,
      yieldQty: material?.yieldQty ?? '1',
      lineCount: material?.lineCount ?? 0,
      unpricedLines: material?.cost.unpricedLines ?? 0,
      price: salePriceDtoOf(sale),
      cost: unitCostDtoOf(cost, time, complete),
      margin: { amount: cost.margin, percent: cost.marginPercent },
    }
    return { product, sortKey, row, cost, complete }
  })
  const atLoss = (c: Costed) => c.cost.margin !== null && compareDecimal(c.cost.margin, '0') < 0
  const counts = {
    all: pagedInSql ? 0 : costed.length,
    incomplete: costed.filter((c) => !c.complete).length,
    loss: costed.filter(atLoss).length,
    noTime: costed.filter((c) => c.cost.ownerTime.state === 'none').length,
  }
  if (pagedInSql) {
    const [row] = (await tx.execute(sql`
        select count(*)::int as total from app.products_services p
         where ${sql.join(conditions, sql` and `)}
      `)) as unknown as { total: number }[]
    counts.all = row?.total ?? 0
  }
  if (input.filter === 'incomplete') costed = costed.filter((c) => !c.complete)
  if (input.filter === 'loss') costed = costed.filter(atLoss)
  if (!byName) {
    const sign = input.order === 'asc' ? 1 : -1
    const byMargin = input.sort === 'margin' || input.sort === 'margin_percent'
    costed.sort((a, b) => {
      const x = sortValue(a, input.sort)
      const y = sortValue(b, input.sort)
      // By margin, an incomplete cost's margin is "at most": after the complete ones.
      if (byMargin && x !== null && y !== null && a.complete !== b.complete) {
        return a.complete ? -1 : 1
      }
      if (x !== null && y !== null) {
        const order = compareDecimal(x, y)
        if (order !== 0) return sign * order
      } else if (x !== null || y !== null) {
        return x === null ? 1 : -1
      }
      // Ties: by name, as the database orders it.
      return a.sortKey - b.sortKey
    })
  }
  const items = pagedInSql ? costed : costed.slice(offset, offset + input.limit)
  const more = pagedInSql ? products.length > input.limit : offset + input.limit < costed.length
  return {
    data: {
      items: items.map((c) => c.row),
      nextCursor: more ? encodeCursor(input, offset + input.limit) : null,
      counts,
      currency: costing.currency,
      today: costing.today,
      averageFrom: averageFromOf(costing.today),
      monthCosts: monthCosts.dto,
      ownerTime: ownerTimeSettingOf(ctx, costing),
    },
    meta: { redacted: [] },
  }
}

// ---------------------------------------------------------------------------------------------------
// productCost.get
// ---------------------------------------------------------------------------------------------------

type Materials = NonNullable<ProductCostBreakdownDto['data']['materials']>

/** The one line of an item bought ready to sell: 1 of the product's unit of its material (D-117). */
async function resaleMaterialsOf(
  tx: Tx,
  businessId: string,
  product: ProductRow,
  materialId: string,
): Promise<{ materials: Omit<Materials, 'averageFrom' | 'averageTo'>; part: MaterialsPart }> {
  const [material] = (await tx.execute(sql`
    select m.id, m.name, m.unit, m.dimension, m.archived_at is not null as archived
      from app.materials m
     where m.business_id = ${businessId} and m.id = ${materialId} and m.deleted_at is null
  `)) as unknown as {
    id: string
    name: string
    unit: StandardUnit
    dimension: ProductCostLineDto['dimension']
    archived: boolean
  }[]
  const record = material
    ? (await costRecordsOf(tx, businessId, [material.id])).get(material.id)
    : undefined
  const found = record ? averageBasisOf(record) : null
  // One unit sold, in base units of the material (its unit is the product's, D-117).
  const basis =
    found && material && dimensionOf(material.unit) === dimensionOf(product.unit) ? found : null
  const baseQty = STANDARD_UNITS[product.unit].factor
  const lineCost = basis ? costOfQty(baseQty, basis) : null
  const perUnit =
    basis && material
      ? costRatio([basis.value, STANDARD_UNITS[material.unit].factor], [basis.qty])
      : null
  const { perUnit: unitCost, tooLarge } = unitCostOf(lineCost)
  const lines: ProductCostLineDto[] = material
    ? [
        {
          materialId: material.id,
          materialName: material.name,
          materialUnit: material.unit,
          dimension: material.dimension,
          materialArchived: material.archived,
          qty: '1',
          unit: product.unit,
          packId: null,
          packName: null,
          baseQty,
          cost:
            basis && lineCost !== null && perUnit !== null
              ? { basis: basis.basis, perUnit, lineCost }
              : null,
          lastPurchase: record ? lastPurchaseOf(record) : null,
        },
      ]
    : []
  return {
    materials: {
      yieldQty: '1',
      lines,
      total: lineCost,
      perUnit: unitCost,
      unpricedLines: lineCost === null ? 1 : 0,
    },
    part: {
      state: 'on',
      perUnit: unitCost,
      lineCount: 1,
      unpricedLines: lineCost === null ? 1 : 0,
      tooLarge,
    },
  }
}

/** The recipe's lines, each at its material's average, with the material's last purchase price. */
async function recipeMaterialsOf(
  tx: Tx,
  businessId: string,
  productId: string,
): Promise<{ materials: Omit<Materials, 'averageFrom' | 'averageTo'>; part: MaterialsPart }> {
  const recipe = await findRecipe(tx, businessId, productId)
  const lines = recipe ? await linesOf(tx, businessId, recipe.id) : []
  const bases = await basesOf(
    tx,
    businessId,
    lines.map((l) => l.material_id),
  )
  const yieldQty = recipe?.yieldQty ?? '1'
  const rolled = rollUpRecipe(
    lines.map((l) => ({ baseQty: l.base_qty, basis: bases.get(l.material_id)?.basis ?? null })),
    yieldQty,
  )
  return {
    materials: {
      yieldQty,
      lines: lines.map((line, i): ProductCostLineDto => {
        const found = bases.get(line.material_id)
        const basis = found?.basis ?? null
        const lineCost = rolled.lines[i] ?? null
        const perUnit = basis
          ? costRatio([basis.value, STANDARD_UNITS[line.material_unit].factor], [basis.qty])
          : null
        return {
          materialId: line.material_id,
          materialName: line.material_name,
          materialUnit: line.material_unit,
          dimension: line.dimension,
          materialArchived: line.material_archived,
          qty: line.qty,
          unit: line.unit,
          packId: line.pack_id,
          packName: line.pack_name,
          baseQty: line.base_qty,
          cost:
            basis && lineCost !== null && perUnit !== null
              ? { basis: basis.basis, perUnit, lineCost }
              : null,
          lastPurchase: found ? lastPurchaseOf(found.record) : null,
        }
      }),
      total: rolled.total,
      perUnit: rolled.perUnit,
      unpricedLines: rolled.unpriced,
    },
    part: {
      state: 'on',
      perUnit: rolled.perUnit,
      lineCount: lines.length,
      unpricedLines: rolled.unpriced,
      tooLarge: rolled.tooLarge,
    },
  }
}

/**
 * `productCost.get`: one product's or service's cost for one unit sold, line by line: each material
 * (quantity, its average per unit, the line's cost and its last purchase price), the running-cost
 * share and how it is worked out (with the business's costs of the last full month, D-202), the
 * owner's time, the total and the margin. NOT_FOUND unless it is a product or service of this
 * business.
 */
export function getProductCost(
  ctx: BusinessCtx,
  input: GetInput,
): Promise<ProductCostBreakdownDto> {
  const businessId = ctx.businessId
  return ctx.tx(async (tx) => {
    const [product] = (await tx.execute(sql`
      select ${productColumns}
        from app.products_services p
       where p.business_id = ${businessId} and p.id = ${input.productId} and p.deleted_at is null
    `)) as unknown as ProductRow[]
    if (!product) throw new AppError('not_found')
    const costing = await costingOf(tx, businessId)
    const monthCosts = await monthCostsOf(tx, ctx, costing)
    let materials: Materials | null = null
    let part: MaterialsPart = { state: 'off' }
    if (passes(ctx, ['materials'])) {
      const averageFrom = averageFromOf(costing.today)
      if (product.resale_material_id !== null) {
        const resale = await resaleMaterialsOf(tx, businessId, product, product.resale_material_id)
        materials = { ...resale.materials, averageFrom, averageTo: costing.today }
        part = resale.part
      } else {
        const recipe = await recipeMaterialsOf(tx, businessId, product.id)
        materials = { ...recipe.materials, averageFrom, averageTo: costing.today }
        part = recipe.part
      }
    }
    const sale = saleOf(product, costing)
    const time = ownerTimeOf(ctx, product, costing)
    const cost = productCost({
      materials: part,
      runningCosts: monthCosts.part,
      ownerTime: time,
      sale,
    })
    return {
      data: {
        productId: product.id,
        name: product.name,
        type: product.type,
        unit: product.unit,
        kind: product.resale_material_id === null ? 'recipe' : 'resale',
        archived: product.archived,
        currency: costing.currency,
        today: costing.today,
        price: salePriceDtoOf(sale),
        materials,
        cost: unitCostDtoOf(cost, time, costCompleteFor(product.type, cost)),
        margin: { amount: cost.margin, percent: cost.marginPercent },
        monthCosts: monthCosts.dto,
        ownerTime: ownerTimeSettingOf(ctx, costing),
      },
      meta: { redacted: [] },
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// productCost.settings / updateSettings
// ---------------------------------------------------------------------------------------------------

async function readSettings(tx: Tx, ctx: BusinessCtx): Promise<ProductCostSettingsDto> {
  const costing = await costingOf(tx, ctx.businessId)
  return {
    data: {
      ownerHourlyRate: costing.hourlyRate,
      hasTeam: ctx.access.capabilities.has_team,
      currency: costing.currency,
    },
    meta: { redacted: [] },
  }
}

/**
 * `productCost.settings`: the owner's hourly rate (D-119), and whether the business has a team (then
 * nothing is left to set: running costs need no setting, D-202).
 */
export function getProductCostSettings(ctx: BusinessCtx): Promise<ProductCostSettingsDto> {
  return ctx.tx((tx) => readSettings(tx, ctx))
}

/**
 * `productCost.updateSettings`: saves the owner's hourly rate (null clears it). Needs costs visible
 * (what it writes is a cost: FORBIDDEN otherwise, before anything is read), and a business without a
 * team (CAPABILITY_DISABLED; kept as it is with one). At most the currency's decimals (VALIDATION).
 * Audited (businesses). Setting it fills the owner's time of the sales finalized without it, once
 * (M3 Step 2).
 */
export function updateProductCostSettings(
  ctx: BusinessCtx,
  input: SettingsInput,
): Promise<ProductCostSettingsDto> {
  assertQueryable(ctx, [{ name: 'ownerHourlyRate', category: 'cost' }])
  if (ctx.access.capabilities.has_team) throw new AppError('capability_disabled')
  return ctx.tx(async (tx) => {
    const { currency } = await costingOf(tx, ctx.businessId)
    if (!isCurrencyCode(currency)) {
      throw new AppError('validation', { message: `currency: ${currency} is not supported` })
    }
    if (input.ownerHourlyRate !== null && !fitsCurrency(input.ownerHourlyRate, currency)) {
      throw new AppError('validation', {
        message: 'ownerHourlyRate: more decimals than the currency has',
      })
    }
    await tx
      .update(businesses)
      .set({ ownerHourlyRate: input.ownerHourlyRate })
      .where(eq(businesses.id, ctx.businessId))
    // The finalized sales whose lines kept the owner's minutes without a rate take it, once (D-222,
    // Q7), under the business row this update locked (sale-costs.ts).
    if (input.ownerHourlyRate !== null) {
      await fillSaleTimeCosts(tx, ctx.businessId, input.ownerHourlyRate)
    }
    return readSettings(tx, ctx)
  })
}
