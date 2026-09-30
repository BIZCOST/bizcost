import type {
  productCostGetInput,
  ProductCostBreakdownDto,
  ProductCostLineDto,
  productCostListInput,
  ProductCostListDto,
  ProductCostRowDto,
  ProductCostSettingsDto,
  RunningCostRateDto,
  SalePriceDto,
  UnitCostDto,
  updateProductCostSettingsInput,
} from '@bizcost/contracts'
import { businesses, type Tx } from '@bizcost/db'
import {
  awaitsServiceShare,
  can,
  checkDecimal,
  compareDecimal,
  costOfQty,
  costRatio,
  dimensionOf,
  fitsCurrency,
  isCurrencyCode,
  monthlyPurchases,
  monthlyTotal,
  PURCHASE_AVERAGE_DAYS,
  priceBeforeVat,
  productCost,
  purchaseMonths,
  rollUpRecipe,
  runningCostRate,
  saleVatRate,
  STANDARD_UNITS,
  unitCostOf,
  type MaterialsPart,
  type OwnerTimePart,
  type ProductCost,
  type ProductType,
  type RunningCostFrequency,
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
import { basesOf, findRecipe, linesOf, materialCostsOf, type ProductMaterialCost } from './recipes'

// Product costs (ROADMAP.md M2 Step 6; D-115, D-116, D-119, D-121, D-178): what one unit sold of each
// product or service costs, line by line, and its margin. Module `cost_engine` (and `products`; the
// router checks them and the keys). Worked out on read, nothing stored: the sums in SQL from the cost
// rows (the purchase ledger, recipes, running costs, the business's settings), each division once in
// the domain (productCost), never rounded to the currency.
//
//   - Materials: its recipe at the materials' averages (the D-115 basis) ÷ what it makes, or, bought
//     ready to sell, its material's average (materialCostsOf in services/recipes.ts, the same as
//     product.costs). With the Materials module off there is no materials line.
//   - Running costs (D-116): the running costs active today, a month (monthlyTotal), ÷ the monthly
//     material purchases: the average of the last 3 full calendar months of posted purchases by
//     business_date (what went into stock: after discounts, without reclaimable VAT, net of returns
//     and credit notes, reversed purchases left out), once 3 full months have passed after the month
//     of the first posted purchase and each of the 3 months holds a posted purchase (D-186); until
//     then (or when that average is 0) the owner's estimate (businesses.estimated_monthly_purchases).
//     A product's share = its materials × that rate. With the Running Costs module off there is no
//     share; with none ever entered it is "not entered yet", never 0 (D-186).
//   - The owner's time (D-119), only without a team: minutes for one unit × hourly rate ÷ 60.
//   - The margin, on the price before VAT (VAT is never revenue; D-114, D-121).
//
// Sensitive: costs `cost`, monthly purchases `supplier_price`, margins `profit_margin` (the redact
// middleware removes them; the three are visible only together, D-187). Sorting or filtering on a
// hidden one is FORBIDDEN before anything is read. The business's monthly running costs and material
// purchases behind the rate are withheld here from a member who may not see running costs and
// purchases (D-186): the rate alone is no more than any product's share ÷ its materials. The settings
// (the estimate, the hourly rate) need those keys, and are written only by a member who sees what
// they write.

type ListInput = z.output<typeof productCostListInput>
type GetInput = z.output<typeof productCostGetInput>
type SettingsInput = z.output<typeof updateProductCostSettingsInput>

/** The business's day and what its costs are worked out with. */
interface Costing {
  readonly today: string
  readonly currency: string
  readonly vatRegistered: boolean
  /** businesses.estimated_monthly_purchases (null: not set). */
  readonly estimate: string | null
  /** businesses.owner_hourly_rate (null: not set). */
  readonly hourlyRate: string | null
}

async function costingOf(tx: Tx, businessId: string): Promise<Costing> {
  const [row] = (await tx.execute(sql`
    select (now() at time zone b.timezone)::date::text as today, trim(b.currency) as currency,
           b.vat_registered, trim_scale(b.estimated_monthly_purchases)::text as estimate,
           trim_scale(b.owner_hourly_rate)::text as hourly_rate
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as {
    today: string
    currency: string
    vat_registered: boolean
    estimate: string | null
    hourly_rate: string | null
  }[]
  if (!row) throw new AppError('forbidden')
  return {
    today: row.today,
    currency: row.currency,
    vatRegistered: row.vat_registered,
    estimate: row.estimate,
    hourlyRate: row.hourly_rate,
  }
}

/** The first day of the 90 days the materials' average covers (D-115). */
function averageFromOf(today: string): string {
  const day = new Date(`${today}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - (PURCHASE_AVERAGE_DAYS - 1))
  return day.toISOString().slice(0, 10)
}

/** A rate that fits a cost amount (numeric(28,12)), else null. */
const fittingRate = (value: string | null) =>
  value !== null && checkDecimal(value, 'costAmount') === null ? value : null

interface Rate {
  readonly part: RunningCostsPart
  readonly dto: RunningCostRateDto
}

/**
 * Whether the member may see the business's monthly running costs and material purchases (D-186):
 * it may see running costs and purchases themselves (their keys, as the Owner does whether or not
 * the modules are on).
 */
function mayReadTotals(ctx: BusinessCtx): boolean {
  return (
    can(ctx.access.effective, 'running_costs.items.view') &&
    can(ctx.access.effective, 'purchases.documents.view')
  )
}

/**
 * How running costs reach products today (D-116): the monthly running costs, the monthly material
 * purchases the rate divides by (the last 3 full months once they count, else the owner's estimate),
 * and the rate. One read of the purchase ledger and one of the running costs. The totals are
 * withheld from the DTO (never from what the costs are worked out with) unless mayReadTotals.
 */
async function rateOf(tx: Tx, ctx: BusinessCtx, costing: Costing): Promise<Rate> {
  const businessId = ctx.businessId
  const window = purchaseMonths(costing.today, null, 0)
  // Each posted purchase line's value (its receipt), net of its returns and credit notes that stand
  // (D-120 rule 4); reversed receipts, returns and credits are left out.
  const [ledger] = (await tx.execute(sql`
    with receipts as (
      select m.id, m.business_date, m.value
        from app.stock_movements m
       where m.business_id = ${businessId}
         and m.kind = 'purchase'
         and not exists (
           select 1 from app.stock_movements r
            where r.business_id = m.business_id and r.reverses_id = m.id)
    ),
    taken as (
      select x.receipt_id, sum(-x.value) as value
        from app.stock_movements x
       where x.business_id = ${businessId}
         and x.kind in ('purchase_return', 'purchase_credit')
         and not exists (
           select 1 from app.stock_movements r
            where r.business_id = x.business_id and r.reverses_id = x.id)
       group by x.receipt_id
    )
    select min(r.business_date)::text as first_day,
           trim_scale(coalesce(sum(r.value - coalesce(t.value, 0)) filter (
             where r.business_date >= ${window.from}::date
               and r.business_date <= ${window.to}::date), 0))::text as months_total,
           (count(distinct date_trunc('month', r.business_date)) filter (
             where r.business_date >= ${window.from}::date
               and r.business_date <= ${window.to}::date))::int as months_bought
      from receipts r
      left join taken t on t.receipt_id = r.id
  `)) as unknown as { first_day: string | null; months_total: string; months_bought: number }[]
  const months = purchaseMonths(
    costing.today,
    ledger?.first_day ?? null,
    Number(ledger?.months_bought ?? 0),
  )
  const purchases = monthlyPurchases({
    months,
    monthsTotal: ledger?.months_total ?? '0',
    estimate: costing.estimate,
  })
  const totalsShown = mayReadTotals(ctx)
  const shown = <T>(value: T): T | null => (totalsShown ? value : null)
  const purchasesDto: RunningCostRateDto['purchases'] = {
    source: purchases.source,
    monthly: shown(purchases.monthly),
    from: months.from,
    to: months.to,
    average: shown(purchases.average),
    estimate: shown(costing.estimate),
    countsFrom: months.countsFrom,
    monthsBought: months.monthsBought,
    ready: months.ready,
  }
  if (!passes(ctx, ['running_costs'])) {
    return {
      part: { state: 'off' },
      dto: {
        state: 'off',
        totalsShown,
        monthlyRunningCosts: null,
        purchases: purchasesDto,
        rate: null,
      },
    }
  }
  // Active: from its start up to the day before it stopped (runningCostActiveOn, D-176). Entered: any
  // running cost not removed, whatever its days (D-186).
  const costs = (await tx.execute(sql`
    select trim_scale(r.amount)::text as amount, r.frequency,
           (r.starts_on <= ${costing.today}::date
             and (r.ends_on is null or r.ends_on > ${costing.today}::date)) as active
      from app.running_costs r
     where r.business_id = ${businessId} and r.deleted_at is null
  `)) as unknown as { amount: string; frequency: RunningCostFrequency; active: boolean }[]
  const entered = costs.length > 0
  const monthlyRunningCosts = monthlyTotal(costs.filter((c) => c.active))
  const none = !(compareDecimal(monthlyRunningCosts, '0') > 0)
  const rate = !entered
    ? null
    : none
      ? '0'
      : purchases.monthly === null
        ? null
        : fittingRate(runningCostRate(monthlyRunningCosts, purchases.monthly))
  const state = !entered
    ? 'not_entered'
    : none
      ? 'none'
      : purchases.monthly === null
        ? 'not_set'
        : 'ready'
  return {
    part: { state: 'on', entered, monthlyRunningCosts, monthlyPurchases: purchases.monthly },
    dto: {
      state,
      totalsShown,
      monthlyRunningCosts: shown(monthlyRunningCosts),
      purchases: purchasesDto,
      rate,
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

function unitCostDtoOf(cost: ProductCost, time: OwnerTimePart): UnitCostDto {
  return {
    materials: cost.materials,
    runningCosts: { state: cost.runningCosts.state, share: cost.runningCosts.share },
    ownerTime: {
      state: cost.ownerTime.state,
      minutes: time.state === 'solo' ? time.minutes : null,
      amount: cost.ownerTime.amount,
    },
    total: cost.total,
    tooLarge: cost.tooLarge,
    reasons: [...cost.reasons],
    complete: cost.complete,
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
 * and filtered to those incomplete or at a loss; with how many of them are incomplete, at a loss or
 * without the owner's minutes. Sorting and filtering on costs or margins need them visible
 * (FORBIDDEN otherwise, before anything is read).
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
  const rate = await rateOf(tx, ctx, costing)
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
      type: product.type,
      materials: part,
      runningCosts: rate.part,
      ownerTime: time,
      sale,
    })
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
      cost: unitCostDtoOf(cost, time),
      margin: { amount: cost.margin, percent: cost.marginPercent },
    }
    return { product, sortKey, row, cost }
  })
  const atLoss = (c: Costed) => c.cost.margin !== null && compareDecimal(c.cost.margin, '0') < 0
  const counts = {
    all: pagedInSql ? 0 : costed.length,
    incomplete: costed.filter((c) => !c.cost.complete).length,
    loss: costed.filter(atLoss).length,
    noTime: costed.filter((c) => c.cost.ownerTime.state === 'none').length,
    servicesAwaitingShare: costed.filter((c) => awaitsServiceShare(c.product.type, c.cost)).length,
  }
  if (pagedInSql) {
    const [row] = (await tx.execute(sql`
        select count(*)::int as total from app.products_services p
         where ${sql.join(conditions, sql` and `)}
      `)) as unknown as { total: number }[]
    counts.all = row?.total ?? 0
  }
  if (input.filter === 'incomplete') costed = costed.filter((c) => !c.cost.complete)
  if (input.filter === 'loss') costed = costed.filter(atLoss)
  if (!byName) {
    const sign = input.order === 'asc' ? 1 : -1
    const byMargin = input.sort === 'margin' || input.sort === 'margin_percent'
    costed.sort((a, b) => {
      const x = sortValue(a, input.sort)
      const y = sortValue(b, input.sort)
      // By margin, an incomplete cost's margin is "at most": after the complete ones.
      if (byMargin && x !== null && y !== null && a.cost.complete !== b.cost.complete) {
        return a.cost.complete ? -1 : 1
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
      rate: rate.dto,
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
 * share and how it was worked out, the owner's time, the total and the margin. NOT_FOUND unless it is
 * a product or service of this business.
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
    const rate = await rateOf(tx, ctx, costing)
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
      type: product.type,
      materials: part,
      runningCosts: rate.part,
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
        cost: unitCostDtoOf(cost, time),
        margin: { amount: cost.margin, percent: cost.marginPercent },
        rate: rate.dto,
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
  const rate = await rateOf(tx, ctx, costing)
  return {
    data: {
      estimatedMonthlyPurchases: costing.estimate,
      ownerHourlyRate: costing.hourlyRate,
      hasTeam: ctx.access.capabilities.has_team,
      currency: costing.currency,
      today: costing.today,
      rate: rate.dto,
    },
    meta: { redacted: [] },
  }
}

/**
 * `productCost.settings`: the owner's estimate of monthly material purchases and hourly rate, and how
 * running costs reach products now.
 */
export function getProductCostSettings(ctx: BusinessCtx): Promise<ProductCostSettingsDto> {
  return ctx.tx((tx) => readSettings(tx, ctx))
}

/**
 * `productCost.updateSettings`: saves each field given (null clears it), keeps the others. Needs
 * costs and supplier prices visible (what it writes are a supplier-price estimate and a cost:
 * FORBIDDEN otherwise, before anything is read). The hourly rate only without a team
 * (CAPABILITY_DISABLED; kept as it is with one). Amounts at most the currency's decimals
 * (VALIDATION). Audited (businesses).
 */
export function updateProductCostSettings(
  ctx: BusinessCtx,
  input: SettingsInput,
): Promise<ProductCostSettingsDto> {
  assertQueryable(ctx, [
    { name: 'estimatedMonthlyPurchases', category: 'supplier_price' },
    { name: 'ownerHourlyRate', category: 'cost' },
  ])
  if (input.ownerHourlyRate !== undefined && ctx.access.capabilities.has_team) {
    throw new AppError('capability_disabled')
  }
  return ctx.tx(async (tx) => {
    const { currency } = await costingOf(tx, ctx.businessId)
    if (!isCurrencyCode(currency)) {
      throw new AppError('validation', { message: `currency: ${currency} is not supported` })
    }
    for (const [name, value] of [
      ['estimatedMonthlyPurchases', input.estimatedMonthlyPurchases],
      ['ownerHourlyRate', input.ownerHourlyRate],
    ] as const) {
      if (value != null && !fitsCurrency(value, currency)) {
        throw new AppError('validation', {
          message: `${name}: more decimals than the currency has`,
        })
      }
    }
    await tx
      .update(businesses)
      .set({
        ...(input.estimatedMonthlyPurchases !== undefined
          ? { estimatedMonthlyPurchases: input.estimatedMonthlyPurchases }
          : {}),
        ...(input.ownerHourlyRate !== undefined ? { ownerHourlyRate: input.ownerHourlyRate } : {}),
      })
      .where(eq(businesses.id, ctx.businessId))
    return readSettings(tx, ctx)
  })
}
