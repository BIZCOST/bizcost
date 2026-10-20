import type { DashboardCardsDto } from '@bizcost/contracts'
import type { Tx } from '@bizcost/db'
import {
  addMonths,
  averageAsOf,
  compareDecimal,
  COST_INCREASE_DAYS,
  COST_INCREASE_PERCENT,
  costIncreasePercent,
  costRatio,
  costsSpanOf,
  firstDayOf,
  marginConcern,
  monthOf,
  netPaid,
  paymentState,
  PURCHASE_AVERAGE_DAYS,
  STANDARD_UNITS,
  type StandardUnit,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { passes } from '../trpc'
import {
  branchLimited,
  businessLevel,
  lastDayOf,
  piecesOf,
  profitEnvOf,
  profitGroups,
  profitShown,
  ratesOf,
  seesSalesTotals,
  usedMaterials,
  type ProfitEnv,
  type ProfitGroupSums,
} from './real-profit'
import { invoicedObligationsOf, obligationsOf } from './receivables'
import { postedPurchaseLinesOf } from './sale-costs'
import { uuidArray } from './stock'

// The Dashboard's decision cards (ROADMAP.md M3 Step 3; PRODUCT.md §9; Q14 of D-218):
// `dashboard.cards`, worked out on read by services/real-profit.ts (nothing stored). Only the cards
// the business has data for and the member may see: none before the first finalized sale, none for
// a member who sees neither the sales totals (every sale, H1) nor profit. Sales figures with
// sales.documents.view; profit and every cost fact (where the money went, a loss or a low margin, cost
// increases, what needs a look) with reports.profit.view (Q11), withheld otherwise (null), and tagged.
// A member limited to some branches sees their branches' sales at the shares those carry, never the
// business's month's costs (D-231). Sales already posted count with Sales switched off (M9).

/** How many products and materials a card lists at most. */
const CARD_ITEMS = 5
const LOOK_ITEMS = 10

const isId = (key: string) => /^[0-9a-f-]{36}$/.test(key)

type Cards = DashboardCardsDto['data']

/** `dashboard.cards` (see above). */
export async function getCards(ctx: BusinessCtx): Promise<DashboardCardsDto> {
  const shown = profitShown(ctx)
  const sees = seesSalesTotals(ctx)
  return ctx.tx(async (tx) => {
    const env = await profitEnvOf(tx, ctx)
    const month = monthOf(env.today)
    const lastMonth = addMonths(month, -1)
    const none: Cards = {
      currency: env.currency,
      today: env.today,
      month,
      lastMonth,
      profitShown: shown,
      profit: null,
      sales: null,
      moneyWent: null,
      byDay: null,
      topProducts: null,
      concerns: null,
      costIncreases: null,
      byChannel: null,
      needsLook: null,
      // M3 Step 5: orders and what customers owe show whether or not anything was sold yet.
      recentOrders: await recentOrdersOf(tx, ctx),
      customersOwe: await customersOweOf(tx, ctx),
      deliveryMargin: null,
    }
    const answer = (data: Cards): DashboardCardsDto => ({ data, meta: { redacted: [] } })
    if (env.firstSaleDay === null || (!sees && !shown)) return answer(none)
    const locations = ctx.access.locationScope
    const scope = locations.all ? null : [...locations.ids]
    const from = firstDayOf(month)
    const lastFrom = firstDayOf(lastMonth)
    const lastTo = lastDayOf(lastMonth)
    const thisAll = await profitGroups(tx, env, { from, to: env.today, grouping: 'all', scope })
    const lastAll = await profitGroups(tx, env, {
      from: lastFrom,
      to: lastTo,
      grouping: 'all',
      scope,
    })
    const soldThisMonth = thisAll.length > 0
    const soldLastMonth = lastAll.length > 0
    if (!soldThisMonth && !soldLastMonth) return answer(none)
    // The business level (for a member who sees profit, not limited to branches): the month's costs
    // in place of the shares its sales carry (the whole of last month, so far this month).
    const level = shown && !branchLimited(ctx)
    const thisLevel = level ? await businessLevel(tx, env, thisAll, from, env.today) : null
    const lastLevel = level ? await businessLevel(tx, env, lastAll, lastFrom, lastTo) : null
    const thisSum = thisLevel?.total ?? thisAll[0]?.sum ?? null
    const lastSum = lastLevel?.total ?? lastAll[0]?.sum ?? null
    const data: Cards = { ...none }
    const sinceFirstSale = monthOf(env.firstSaleDay) <= lastMonth

    if (sees) {
      data.sales = {
        from,
        to: env.today,
        value: thisAll[0]?.sum.sales ?? '0',
        lastMonth: soldLastMonth ? (lastAll[0]?.sum.sales ?? '0') : null,
      }
    }
    if (shown) {
      // The month's costs so far the business level takes off, and from which day (D-250).
      const monthCosts = thisLevel?.total.monthCosts ?? null
      data.profit = {
        from,
        to: env.today,
        profit: thisSum?.profit ?? '0',
        marginPercent: thisSum?.marginPercent ?? null,
        // Last month only once the business sold (from its first sale's month).
        lastMonthProfit: sinceFirstSale ? (lastSum?.profit ?? null) : null,
        lastMonthMarginPercent: sinceFirstSale ? (lastSum?.marginPercent ?? null) : null,
        complete: thisSum?.complete ?? true,
        beforeRunningCosts: thisSum?.beforeRunningCosts ?? false,
        sold: soldThisMonth,
        monthCosts,
        costsFrom:
          monthCosts === null
            ? null
            : (costsSpanOf(month, env.today, env.firstSaleDay)?.from ?? null),
      }
    }
    if (!soldThisMonth || thisSum === null) return answer(data)

    if (shown) {
      data.deliveryMargin = await deliveryMarginOf(tx, env, thisSum, from, scope)
      data.moneyWent = {
        sales: thisSum.sales,
        materials: thisSum.materials,
        fees: thisSum.fees,
        deliveryCost: thisSum.deliveryCost,
        runningCosts: thisLevel?.total.monthCosts ?? thisSum.runningCosts,
        ownerTime: thisSum.ownerTime,
        profit: thisSum.profit,
      }
    }
    // "Sales and real profit by day": every day of the month so far, a day without sales at 0.
    const byDay = await profitGroups(tx, env, { from, to: env.today, grouping: 'day', scope })
    const days = new Map(byDay.map((g) => [g.key, g.sum] as const))
    const rate = shown ? (await ratesOf(tx, env, [month])).get(month)! : null
    const list: NonNullable<Cards['byDay']> = {
      days: [],
      rateState: rate?.rate.state ?? null,
      showsOn: rate?.showsOn ?? null,
    }
    for (let day = from; day <= env.today; day = nextDay(day)) {
      const sum = days.get(day)
      list.days.push({
        day,
        sales: sum?.sales ?? '0',
        profit: shown ? (sum?.profit ?? '0') : null,
      })
    }
    data.byDay = list

    const byProduct = await profitGroups(tx, env, {
      from,
      to: env.today,
      grouping: 'product',
      scope,
    })
    const products = byProduct.filter((g) => isId(g.key))
    const names = await productNamesOf(
      tx,
      ctx.businessId,
      products.map((g) => g.key),
    )
    const nameOf = (id: string) => names.get(id)?.name ?? ''
    const byName = (a: string, b: string) =>
      nameOf(a).localeCompare(nameOf(b)) || (a < b ? -1 : a > b ? 1 : 0)
    const figure = (g: ProfitGroupSums) => ({
      productId: g.key,
      name: nameOf(g.key),
      unit: names.get(g.key)?.unit ?? 'piece',
      quantity: g.quantity,
      sales: g.sum.sales,
      profit: shown ? g.sum.profit : null,
      marginPercent: shown ? g.sum.marginPercent : null,
    })
    if (sees && products.length > 0) {
      data.topProducts = {
        byQuantity: [...products]
          .sort((a, b) => compareDecimal(b.quantity, a.quantity) || byName(a.key, b.key))
          .slice(0, CARD_ITEMS)
          .map(figure),
        // By real margin %, among products whose costs are complete (an incomplete one's margin is
        // only "at most").
        byMargin: shown
          ? products
              .filter((g) => g.sum.marginPercent !== null && g.sum.complete)
              .sort(
                (a, b) =>
                  compareDecimal(b.sum.marginPercent!, a.sum.marginPercent!) ||
                  byName(a.key, b.key),
              )
              .slice(0, CARD_ITEMS)
              .map(figure)
          : null,
      }
    }
    const byChannel = await profitGroups(tx, env, {
      from,
      to: env.today,
      grouping: 'channel',
      scope,
    })
    if (shown) {
      // A loss or a low margin (Q14: under 10 %): the lowest first. An incomplete cost only lowers a
      // margin further, so one already under 10 % is low whatever is missing.
      const concerns = products
        .map((g) => ({ g, concern: marginConcern(g.sum.marginPercent) }))
        .filter((c) => c.concern !== null)
        .sort(
          (a, b) =>
            compareDecimal(a.g.sum.marginPercent!, b.g.sum.marginPercent!) ||
            byName(a.g.key, b.g.key),
        )
        .slice(0, LOOK_ITEMS)
        .map(({ g, concern }) => ({
          productId: g.key,
          name: nameOf(g.key),
          concern,
          marginPercent: g.sum.marginPercent,
          sales: g.sum.sales,
        }))
      data.concerns = concerns.length > 0 ? concerns : null
      data.costIncreases = await costIncreasesOf(tx, env, from, scope)
      data.needsLook = await needsLookOf(tx, env, scope, byChannel, products, names)
    }
    const channels = byChannel.filter((g) => env.channels.has(g.key))
    if (sees && channels.length >= 2) {
      data.byChannel = channels
        .map((g) => {
          const channel = env.channels.get(g.key)!
          return {
            channelId: g.key,
            name: channel.name,
            kind: channel.kind,
            sales: g.sum.sales,
            profit: shown ? g.sum.profit : null,
            marginPercent: shown ? g.sum.marginPercent : null,
          }
        })
        .sort((a, b) => compareDecimal(b.sales, a.sales) || a.name.localeCompare(b.name))
    }
    return answer(data)
  })
}

function nextDay(day: string): string {
  const next = new Date(`${day}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

function daysBefore(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() - days)
  return at.toISOString().slice(0, 10)
}

async function productNamesOf(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, { name: string; unit: string }>> {
  if (ids.length === 0) return new Map()
  const rows = (await tx.execute(sql`
    select p.id, p.name, p.unit from app.products_services p
     where p.business_id = ${businessId} and p.id = any(${uuidArray([...ids])})
  `)) as unknown as { id: string; name: string; unit: string }[]
  return new Map(rows.map((r) => [r.id, { name: r.name, unit: r.unit }] as const))
}

/**
 * "Cost increases" (Q14): the materials in what sold this month (within the member's branches) whose
 * 90-day average (D-115, as of a day) rose 10 % or more in 30 days, the largest rise first, per the
 * material's unit. Null when none.
 */
async function costIncreasesOf(
  tx: Tx,
  env: ProfitEnv,
  from: string,
  scope: readonly string[] | null,
): Promise<Cards['costIncreases']> {
  const rows = (await tx.execute(sql`
    select distinct x.material_id, m.name, m.unit
      from ${piecesOf(env.businessId, { from, to: env.today, scope })} p
      join app.sale_line_materials x
        on x.business_id = ${env.businessId} and x.sale_id = p.sale_id and x.deleted_at is null
      join app.materials m on m.business_id = x.business_id and m.id = x.material_id
  `)) as unknown as { material_id: string; name: string; unit: StandardUnit }[]
  if (rows.length === 0) return null
  const purchases = await postedPurchaseLinesOf(
    tx,
    env.businessId,
    rows.map((r) => r.material_id),
  )
  const then = daysBefore(env.today, COST_INCREASE_DAYS)
  const result = rows.flatMap((row) => {
    const lines = purchases.get(row.material_id) ?? []
    const old = averageAsOf(then, lines)
    const now = averageAsOf(env.today, lines)
    if (old === null || now === null) return []
    const factor = STANDARD_UNITS[row.unit].factor
    const before = costRatio([old.value, factor], [old.qty])
    const after = costRatio([now.value, factor], [now.qty])
    if (before === null || after === null) return []
    const percent = costIncreasePercent(before, after)
    if (percent === null || compareDecimal(percent, COST_INCREASE_PERCENT) < 0) return []
    return [
      {
        materialId: row.material_id,
        name: row.name,
        unit: row.unit as string,
        before: before as string,
        now: after as string,
        percent,
      },
    ]
  })
  result.sort((a, b) => compareDecimal(b.percent, a.percent) || a.name.localeCompare(b.name))
  return result.length > 0 ? result.slice(0, CARD_ITEMS) : null
}

/**
 * "Needs a look" (cost facts): materials behind finalized sales of the member's branches (any day: the
 * purchase that prices one fills it, D-229) that have no price yet; channels that sold this month and keep a part of each sale with no commission %, statement or fees expense
 * ("before app fees"); products sold this month without a recipe while Materials is on; materials
 * bought in the last 90 days that no product or service uses (Q13 A: they count with the costs, so
 * add them to a recipe instead). Null when nothing needs a look.
 */
async function needsLookOf(
  tx: Tx,
  env: ProfitEnv,
  scope: readonly string[] | null,
  byChannel: readonly ProfitGroupSums[],
  products: readonly ProfitGroupSums[],
  names: ReadonlyMap<string, { name: string }>,
): Promise<Cards['needsLook']> {
  const businessId = env.businessId
  const unpriced = (await tx.execute(sql`
    select distinct m.id, m.name
      from ${piecesOf(businessId, { scope })} p
      join app.sale_line_materials x
        on x.business_id = ${businessId} and x.sale_id = p.sale_id and x.deleted_at is null
       and x.cost is null
      join app.materials m on m.business_id = x.business_id and m.id = x.material_id
     order by m.name
     limit ${LOOK_ITEMS}
  `)) as unknown as { id: string; name: string }[]
  const channelsWithoutFees = byChannel.flatMap((g) => {
    const channel = env.channels.get(g.key)
    return channel && g.sum.reasons.includes('fees_not_entered')
      ? [{ id: channel.id, name: channel.name }]
      : []
  })
  const productsWithoutRecipe = products
    .filter((g) => g.sum.reasons.includes('no_recipe'))
    .map((g) => ({ id: g.key, name: names.get(g.key)?.name ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, LOOK_ITEMS)
  const since = daysBefore(env.today, PURCHASE_AVERAGE_DAYS - 1)
  const unused = env.purchasesOn
    ? ((await tx.execute(sql`
        with used as ${usedMaterials(businessId)}
        select distinct m.id, m.name
          from app.purchase_lines pl
          join app.purchases pu
            on pu.business_id = pl.business_id and pu.id = pl.purchase_id and pu.deleted_at is null
          join app.materials m on m.business_id = pl.business_id and m.id = pl.material_id
         where pl.business_id = ${businessId} and pl.deleted_at is null and pl.kind = 'material'
           and pu.status = 'posted' and pu.business_date >= ${since}::date
           and pl.material_id not in (select u.material_id from used u)
         order by m.name
         limit ${LOOK_ITEMS}
      `)) as unknown as { id: string; name: string }[])
    : []
  const look = {
    unpricedMaterials: unpriced.map((r) => ({ id: r.id, name: r.name })),
    channelsWithoutFees,
    productsWithoutRecipe,
    materialsInNoRecipe: unused.map((r) => ({ id: r.id, name: r.name })),
  }
  return Object.values(look).some((items) => items.length > 0) ? look : null
}

// ---------------------------------------------------------------------------------------------------
// M3 Step 5: Recent orders, What customers owe, Delivery margin
// ---------------------------------------------------------------------------------------------------

/** How many orders "Recent orders" lists. */
const RECENT_ORDERS = 5

/**
 * "Recent orders" (the mockup: #1001, its first item, amount, Pending/Delivered): the newest orders
 * the member may see (every order with orders.documents.view, else their own; their branches), while
 * Orders is on; null otherwise. Paid / Deposit paid / Not paid with
 * payments.customers.view.
 */
async function recentOrdersOf(tx: Tx, ctx: BusinessCtx): Promise<Cards['recentOrders']> {
  const all = passes(ctx, ['orders', 'orders.documents.view'])
  if (!all && !passes(ctx, ['orders', 'orders.documents.manage'])) return null
  const scope = ctx.access.locationScope
  const payments = passes(ctx, ['payments', 'payments.customers.view'])
  const rows = (await tx.execute(sql`
    with ob as materialized (select * from ${obligationsOf(ctx.businessId)} x)
    select o.id, o.number, o.status, o.due_date::text as due_date, trim_scale(o.total + o.rounding_difference)::text as total,
           c.name as customer_name,
           (select l.description from app.order_lines l
             where l.business_id = o.business_id and l.order_id = o.id and l.kind = 'item'
               and l.deleted_at is null
             order by l.position, l.id limit 1) as item_name,
           greatest((select count(*)::int from app.order_lines l
             where l.business_id = o.business_id and l.order_id = o.id and l.kind = 'item'
               and l.deleted_at is null) - 1, 0) as more_items,
           trim_scale(coalesce(d.total_n, di.total_n))::text as d_total,
           trim_scale(coalesce(d.credited_n, di.credited_n))::text as d_credited,
           trim_scale(coalesce(d.paid_n, di.paid_n))::text as d_paid,
           trim_scale(coalesce(d.refunded_n, di.refunded_n))::text as d_refunded
      from app.orders o
      left join app.customers c on c.business_id = o.business_id and c.id = o.customer_id
      left join ob d on d.kind = 'order' and d.id = o.id and not d.invoiced
      -- An invoiced order owes through its invoices and its rest (A2, M3 Step 8, D-313).
      left join ${invoicedObligationsOf(ctx.businessId, 'order_id', sql`ob`)} di
        on di.source_id = o.id
     where o.business_id = ${ctx.businessId} and o.deleted_at is null
       ${all ? sql`` : sql`and o.created_by = app.current_user_id()`}
       ${scope.all ? sql`` : sql`and o.location_id = any(${uuidArray([...scope.ids])})`}
     order by o.created_at desc, o.id desc
     limit ${RECENT_ORDERS}
  `)) as unknown as {
    id: string
    number: string
    status: 'pending' | 'delivered' | 'cancelled'
    due_date: string | null
    total: string
    customer_name: string | null
    item_name: string | null
    more_items: number
    d_total: string | null
    d_credited: string
    d_paid: string
    d_refunded: string
  }[]
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    itemName: r.item_name,
    moreItems: r.more_items,
    customerName: r.customer_name,
    total: r.total,
    status: r.status,
    paymentState:
      payments && r.d_total !== null
        ? paymentState(r.d_total, r.d_credited, netPaid(r.d_paid, r.d_refunded))
        : null,
    dueDate: r.due_date,
  }))
}

/**
 * "What customers owe": every customer's orders and sales "they'll pay later" (the member's
 * branches), with payments.customers.view and Payments on; null otherwise.
 */
async function customersOweOf(tx: Tx, ctx: BusinessCtx): Promise<Cards['customersOwe']> {
  if (!passes(ctx, ['payments', 'payments.customers.view'])) return null
  const scope = ctx.access.locationScope
  const [row] = (await tx.execute(sql`
    select trim_scale(coalesce(sum(greatest(d.left_n, 0)), 0))::text as owed,
           trim_scale(coalesce(sum(greatest(-d.left_n, 0)), 0))::text as overpaid,
           (count(distinct d.customer_id) filter (where d.left_n > 0))::int as customers,
           (count(*) filter (where d.left_n > 0))::int as documents
      from ${obligationsOf(ctx.businessId)} d
     where ${scope.all ? sql`true` : sql`d.location_id = any(${uuidArray([...scope.ids])})`}
  `)) as unknown as { owed: string; overpaid: string; customers: number; documents: number }[]
  return {
    owed: row?.owed ?? '0',
    overpaid: row?.overpaid ?? '0',
    customers: row?.customers ?? 0,
    documents: row?.documents ?? 0,
  }
}

/**
 * "Delivery margin" this month (the member's branches): what customers were charged for delivery,
 * what the deliveries cost the business, and the margin (cost facts: profit seen). Null without a
 * sale with delivery this month.
 */
async function deliveryMarginOf(
  tx: Tx,
  env: ProfitEnv,
  sum: { deliveryCharged: string; deliveryCost: string; deliveryMargin: string },
  from: string,
  scope: readonly string[] | null,
): Promise<Cards['deliveryMargin']> {
  const [row] = (await tx.execute(sql`
    with p as ${piecesOf(env.businessId, { from, to: env.today, scope })}
    select (count(*) filter (where p.sign = 1 and p.delivery_needed))::int as deliveries,
           (count(*) filter (where p.sign = 1 and p.delivery_needed and p.delivery_cost is null))::int
             as not_entered
      from p
  `)) as unknown as { deliveries: number; not_entered: number }[]
  if (!row || row.deliveries === 0) return null
  return {
    from,
    to: env.today,
    deliveries: row.deliveries,
    charged: sum.deliveryCharged,
    cost: sum.deliveryCost,
    margin: sum.deliveryMargin,
    notEntered: row.not_entered,
  }
}
