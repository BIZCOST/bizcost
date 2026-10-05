import { RATE_BASES, REAL_PROFIT_REASONS, SALE_SHARE_STATES } from '@bizcost/domain'
import { z } from 'zod'
import { withMeta } from '../envelope'
import { zBusinessDate, zBusinessMonth } from '../primitives'
import { sensitive } from '../sensitivity'

// Reports → Real profit (M3 Step 3; D-223; the owner's answers Q6–Q8, Q11, Q14 of D-218): worked out
// on read from the posted sales and their frozen costs, the month's costs, the channels' fees and the
// owner's time; nothing is stored.
//
//   real profit = sales before VAT − materials − app fees − delivery cost − running costs
//                 − the owner's time (without a team)
//
// Who sees what (Q11, H1, H2):
//   - the sales figures (sales before VAT, item sales, delivery charged, quantities) with
//     `reports.sales.view` (which needs every sale seen: the sales totals);
//   - everything else (materials, fees, delivery cost and margin, running costs, the owner's time,
//     profit and margin %, the rates and the month's costs, the completeness note) only with
//     `reports.profit.view` (with the costs switch and Product costs, D-190). For anyone else the
//     service withholds them (null, `profitShown` false), and they are tagged too: costs `cost`,
//     profit `profit_margin`.
//   - The month's running-cost TOTAL shows to whoever sees profit (Q11 A: an accepted residue); its
//     categories never do here (they stay with Running Costs and Expenses).
//   - A member limited to some branches sees only their branches' sales, and no business-level line
//     (no month's costs, no "not carried by sales").
//   - Grouping by branch needs branches (CAPABILITY_DISABLED); sorting or showing by a value the
//     member cannot see is FORBIDDEN (before anything is read).
// Figures are unbounded decimal strings, never rounded here (12 decimals; screens round): a hidden
// cost is never too large to answer (D-209).

/** A decimal string of any length (an output: frozen costs are unbounded numeric, D-209). */
const amount = z.string().regex(/^-?\d+(?:\.\d+)?$/)
const costAmount = () => sensitive(amount.nullable(), 'cost')
const profitAmount = () => sensitive(amount.nullable(), 'profit_margin')

/** How profit.summary groups its sales (by order comes with Orders, Step 5). */
export const PROFIT_GROUPS = ['month', 'week', 'day', 'product', 'channel', 'branch'] as const
export type ProfitGroup = (typeof PROFIT_GROUPS)[number]

/**
 * Sorted by: the group itself (`key`: months, weeks and days in time order; products, channels and
 * branches by name), the sales, the profit or the margin % (the last two need profit seen).
 */
export const PROFIT_SORTS = ['key', 'sales', 'profit', 'margin_percent'] as const
export type ProfitSort = (typeof PROFIT_SORTS)[number]

/**
 * Which groups: all, those at a loss or a low margin (real margin under 10 %, Q14), or those whose
 * costs are not complete. Every one but `all` needs profit seen.
 */
export const PROFIT_SHOWS = ['all', 'loss', 'low_margin', 'incomplete'] as const
export type ProfitShow = (typeof PROFIT_SHOWS)[number]

/** A period of at most 12 months (the API refuses a longer one: VALIDATION). */
export const PROFIT_PERIOD_MONTHS_MAX = 12

export const realProfitReasonDto = z.enum(REAL_PROFIT_REASONS)

/**
 * `profit.summary`: the days `from` … `to` (both included; `to` after today counts up to today), at
 * most 12 months.
 */
export const profitSummaryInput = z
  .object({
    from: zBusinessDate,
    to: zBusinessDate,
    groupBy: z.enum(PROFIT_GROUPS).default('month'),
    sort: z.enum(PROFIT_SORTS).default('key'),
    order: z.enum(['asc', 'desc']).default('asc'),
    show: z.enum(PROFIT_SHOWS).default('all'),
  })
  .refine((input) => input.from <= input.to, {
    message: 'to must not be before from',
    path: ['to'],
  })
export type ProfitSummaryInput = z.input<typeof profitSummaryInput>

/** What some sold lines came to, part by part (see above). */
export const profitPartsDto = z.object({
  /** Sales before VAT (the lines' net, a refund's negative), delivery charged included. */
  sales: amount,
  /** Of which items (what the share and the fees are divided by). */
  itemSales: amount,
  /** Of which delivery charged to customers. */
  deliveryCharged: amount,
  /** Materials by the recipes, at the average frozen on each sale's day; null: withheld. */
  materials: costAmount(),
  /** App and selling fees of the channels. */
  fees: costAmount(),
  /** What the deliveries cost the business, and charged − cost. */
  deliveryCost: costAmount(),
  deliveryMargin: profitAmount(),
  /** The running-cost shares the sales carry (the business level subtracts the month's costs). */
  runningCosts: costAmount(),
  /** The owner's time (without a team). */
  ownerTime: costAmount(),
  /** sales − every part above (12 decimals). */
  profit: profitAmount(),
  /** profit ÷ sales × 100; null with sales of zero or less. */
  marginPercent: profitAmount(),
  /** A share is not in it yet (no sales to divide by, or fewer than 7 days of a first month's). */
  beforeRunningCosts: sensitive(z.boolean().nullable(), 'cost'),
  /** Nothing missing (every reason empty). */
  complete: sensitive(z.boolean().nullable(), 'cost'),
  /** What is missing, in REAL_PROFIT_REASONS order (cost facts: withheld like profit, H2). */
  reasons: sensitive(z.array(realProfitReasonDto).nullable(), 'cost'),
})
export type ProfitPartsDto = z.infer<typeof profitPartsDto>

/** One group of the report. */
export const profitGroupDto = profitPartsDto.extend({
  /**
   * The group: a month (YYYY-MM), a week (its Monday, YYYY-MM-DD), a day (YYYY-MM-DD), or the id of a
   * product, a channel or a branch.
   */
  key: z.string(),
  /** A product's, channel's or branch's name as it is now; null for months, weeks and days. */
  name: z.string().nullable(),
  /** The days of the period it covers (a week or a month cut by the period: its days in it). */
  from: zBusinessDate.nullable(),
  to: zBusinessDate.nullable(),
  /** By product: the quantity sold in its unit (a refund's negative); null for the other groups. */
  quantity: amount.nullable(),
  /** By product: its unit; by channel: its kind; null otherwise. */
  unit: z.string().nullable(),
  channelKind: z.string().nullable(),
})
export type ProfitGroupDto = z.infer<typeof profitGroupDto>

/**
 * How the running costs of each month of the period are counted (Q6): the rate its sales carry, and,
 * at the business level, the costs subtracted and what the sales did not carry. "Running costs:
 * September's AED 20,000 ÷ AED 80,000 of sales = 25 % of each sale's price".
 */
export const profitMonthDto = z.object({
  /** The month whose sales this is about (YYYY-MM). */
  month: zBusinessMonth,
  /** Its days in the period. */
  from: zBusinessDate,
  to: zBusinessDate,
  /** The rate's state (SALE_SHARE_STATES); null: withheld (profit not seen). */
  state: sensitive(z.enum(SALE_SHARE_STATES).nullable(), 'cost'),
  basis: sensitive(z.enum(RATE_BASES).nullable(), 'cost'),
  /** The month whose costs and sales give the rate, and their days (null: the whole month). */
  rateMonth: sensitive(zBusinessMonth.nullable(), 'cost'),
  rateFrom: sensitive(zBusinessDate.nullable(), 'cost'),
  rateTo: sensitive(zBusinessDate.nullable(), 'cost'),
  /** `before_running_costs`: the day the rate shows. */
  showsOn: sensitive(zBusinessDate.nullable(), 'cost'),
  /** The costs divided, the item sales they are divided by, and the rate (costs ÷ sales). */
  rateCosts: costAmount(),
  rateSales: costAmount(),
  rate: costAmount(),
  /**
   * The business level (null for a member limited to branches, or with both modules off): the
   * month's costs subtracted for its days in the period (whole, so far, or from the first sale), and
   * "Running costs not carried by this month's sales" (those costs − the shares its sales carry).
   */
  costs: costAmount(),
  notCarried: costAmount(),
})
export type ProfitMonthDto = z.infer<typeof profitMonthDto>

/**
 * How complete the answer is ("96 % of sales have complete costs", and what is missing; H2). On the
 * sales each line concerns (its size: a sale taken back on a later day counts by its own lines, never
 * against another's), so 0 ≤ percent ≤ 100 and every amount missing is zero or more.
 */
export const profitCompletenessDto = z.object({
  /** Sales before VAT the lines considered concern (items, delivery and charges; each line's size). */
  sales: amount,
  /** Of which, lines whose profit is complete. */
  completeSales: amount,
  /** completeSales ÷ sales × 100 (12 decimals); null with sales of zero. */
  percent: amount.nullable(),
  /** Each reason with the sales it concerns, in REAL_PROFIT_REASONS order. */
  missing: z.array(z.object({ reason: realProfitReasonDto, sales: amount })),
})

export const profitSummaryDto = withMeta(
  z.object({
    /** The days counted (`to` up to today). */
    from: zBusinessDate,
    to: zBusinessDate,
    groupBy: z.enum(PROFIT_GROUPS),
    currency: z.string(),
    today: zBusinessDate,
    /** The member sees profit and what it is made of (reports.profit.view with what it needs). */
    profitShown: z.boolean(),
    /**
     * The business-level line is in `total` (the month's costs in place of the shares): false for a
     * member limited to branches (their branches' sales and shares only), and when nothing was sold.
     */
    businessLevel: z.boolean(),
    groups: z.array(profitGroupDto),
    /** Every group added; at the business level, with the month's costs in place of the shares. */
    total: profitPartsDto.extend({
      /** The month's costs subtracted (business level), and those − the shares carried. */
      monthCosts: costAmount(),
      notCarried: costAmount(),
      /**
       * Of `fees` (business level): the expenses marked as a channel's fees for a month that channel
       * sold nothing in (no sales to sit on), less what reversals of earlier months' take back in it.
       */
      feesNotCarried: costAmount(),
    }),
    months: z.array(profitMonthDto),
    completeness: sensitive(profitCompletenessDto.nullable(), 'cost'),
  }),
)
export type ProfitSummaryDto = z.infer<typeof profitSummaryDto>
