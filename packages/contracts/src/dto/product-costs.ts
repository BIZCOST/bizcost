import {
  checkDecimal,
  compareDecimal,
  INCOMPLETE_REASONS,
  POOL_SOURCES,
  PRODUCT_TYPES,
  type RunningShareState,
} from '@bizcost/domain'
import { z } from 'zod'
import { CATALOG_SEARCH_MAX_LENGTH } from '../catalog'
import { withMeta } from '../envelope'
import { zBusinessDate, zBusinessMonth, zDecimal, zUuid } from '../primitives'
import {
  PRODUCT_COST_FILTERS,
  PRODUCT_COST_PAGE_SIZE,
  PRODUCT_COST_PAGE_SIZE_MAX,
  PRODUCT_COST_SORTS,
} from '../product-costs'
import { sensitive } from '../sensitivity'
import { dimensionDto, standardUnitDto } from './catalog'
import { averageBasisDto } from './purchases'
import { productCostKindDto } from './recipes'

// Product costs (ROADMAP.md M2 Step 6; D-115, D-119, D-121, D-178, D-202): what one unit sold of each
// product or service costs, line by line, and its margin, worked out on read (nothing stored):
//   - materials: its recipe at the materials' averages ÷ what the recipe makes, or, bought ready to
//     sell, its material's average;
//   - running costs, by its price (D-202, the owner's decision of 2026-09-30, which replaces D-116's
//     share of the material cost): its price before VAT × the month's costs ÷ the month's sales. Sales
//     arrive in Phase 3, so in M2 the line says it is worked out once sales are recorded
//     (`awaiting_sales`), and the total and the margin are before running costs
//     (`beforeRunningCosts`); without a price no share can be worked out by it (`no_price`). The
//     business's costs of the last full calendar month are shown with it (`monthCosts`): per
//     category, its bills or its running costs' regular amount, counted once;
//   - the owner's time, for a business without a team: minutes × hourly rate ÷ 60;
//   - the total (their exact sum), the price before VAT, and the margin on it (amount and %).
// Never rounded here (12 decimals; screens round). Nothing missing is ever 0: its value is null and
// `reasons` says why, so the screen says it plainly and marks the total incomplete.
//
// Sensitive: costs, what they are made of and why they are incomplete are `cost`; supplier prices
// `supplier_price`; margins `profit_margin`. The three are visible only together (D-144, D-187:
// price − cost is the margin). Outputs are withMeta() envelopes. Sorting or filtering on a hidden
// value is FORBIDDEN (the API checks it before anything is read). The month's costs are shown only to
// a member who may also see running costs and expenses (D-202); others get none of their amounts.

/** Why a product's cost is incomplete (INCOMPLETE_REASONS in @bizcost/domain). */
export const incompleteReasonDto = z.enum(INCOMPLETE_REASONS)

/**
 * The running-cost line of a product (RUNNING_SHARE_STATES in @bizcost/domain, as M2 gives them):
 * `off` (neither Running Costs nor Expenses is on: nothing to share), `no_price` (no price, so no
 * share by it: an incomplete reason, "add its price"), `awaiting_sales` (worked out automatically once
 * sales are recorded: Phase 3 turns the share on, with its states `none` and `applied`).
 */
export const runningShareStateDto = z.enum([
  'off',
  'no_price',
  'awaiting_sales',
] as const satisfies readonly RunningShareState[])

/** The owner's time line: `team` (none with a team), `none` (no minutes), `rate_not_set`, `applied`. */
export const ownerTimeStateDto = z.enum(['team', 'none', 'rate_not_set', 'applied'])

/** One category of the month's costs (costPool in @bizcost/domain). */
export const monthCostCategoryDto = z.object({
  categoryId: zUuid,
  /** The category's name (cost_categories.name). */
  name: z.string(),
  /**
   * `bills`: its expenses for the period that holds the month (they replace its running costs'
   * regular amount, never both); `regular`: its running costs' regular amount for the days they ran;
   * `taken_back`: only a reversal of an earlier month's bill counts in it (D-203).
   */
  source: z.enum(POOL_SOURCES),
  /** What it counts in the month (12 decimals; zero or less after a reversal taken back in it). */
  amount: zDecimal,
  /** Its running costs' regular amount for the month, when it had any (not counted beside bills). */
  regular: zDecimal.nullable(),
  /**
   * With `bills`: the quarter or year of its quarterly or yearly running cost they pay for (its first
   * and last month, 3 or 12 months, and what its bills come to), spread evenly over its months
   * (D-203); null: the month's own bills.
   */
  period: z
    .object({
      from: zBusinessMonth,
      to: zBusinessMonth,
      months: z.union([z.literal(3), z.literal(12)]),
      bills: zDecimal,
    })
    .nullable(),
  /** What reversals of earlier months' bills take back in this month (already out of `amount`). */
  takenBack: zDecimal.nullable(),
})
export type MonthCostCategoryDto = z.infer<typeof monthCostCategoryDto>

/**
 * How the business's running costs reach what it sells (D-202), with its costs of the last full
 * calendar month: every running cost and finalized expense counted once (an expense in the month it
 * belongs to; a category's bills replace its regular amount, over the quarter or year they pay for
 * when its running cost is quarterly or yearly, D-203). Phase 3 divides them by the same month's
 * sales before VAT. Material purchases and the owner's time are not in them.
 */
export const monthCostsDto = z.object({
  /**
   * `off`: neither Running Costs nor Expenses is on; `awaiting_sales`: shared once sales are
   * recorded (Phase 3).
   */
  state: sensitive(z.enum(['off', 'awaiting_sales']), 'cost'),
  /** A running cost was ever entered (removed ones aside): without any, the page asks for them. */
  runningCostsEntered: sensitive(z.boolean(), 'cost'),
  /** The month shown: the last full calendar month (YYYY-MM). */
  month: zBusinessMonth,
  /**
   * The amounts below are shown: the member may see costs, running costs
   * (running_costs.items.view) and expenses (expenses.documents.view). Otherwise they are null.
   */
  amountsShown: z.boolean(),
  /** The month's costs (Σ of the categories, exact); null when off or not shown. */
  total: sensitive(zDecimal.nullable(), 'cost'),
  /** Each category with something in the month, the largest first; null when off or not shown. */
  categories: sensitive(z.array(monthCostCategoryDto).nullable(), 'cost'),
})
export type MonthCostsDto = z.infer<typeof monthCostsDto>

/** The price the margin is taken from (not sensitive: every member who sees products sees it). */
export const salePriceDto = z.object({
  /** The product's default price, as set (null: not set yet). */
  defaultPrice: zDecimal.nullable(),
  /** Whether it includes VAT (D-121). */
  includesVat: z.boolean(),
  /** The VAT rate taken out of it, in percent: 5 for a VAT-registered business's standard price. */
  vatRate: zDecimal,
  /** The price before VAT (12 decimals; the price itself when nothing is taken out). */
  beforeVat: zDecimal.nullable(),
})
export type SalePriceDto = z.infer<typeof salePriceDto>

/** One unit's cost, line by line (see above). */
export const unitCostDto = z.object({
  /** Materials for one unit sold; null: none priced yet, too large, or Materials off. */
  materials: sensitive(zDecimal.nullable(), 'cost'),
  runningCosts: z.object({
    state: sensitive(runningShareStateDto, 'cost'),
  }),
  ownerTime: z.object({
    state: sensitive(ownerTimeStateDto, 'cost'),
    /** The owner's minutes for one unit (null: none, or a business with a team). */
    minutes: sensitive(zDecimal.nullable(), 'cost'),
    /** minutes × hourly rate ÷ 60 (null unless `applied`). */
    amount: sensitive(zDecimal.nullable(), 'cost'),
  }),
  /** The exact sum of the lines worked out; null when none is (or too large). */
  total: sensitive(zDecimal.nullable(), 'cost'),
  /**
   * The running-cost share applies and is not in the total yet (awaiting sales, or no price): the
   * total and the margin are before running costs, never final.
   */
  beforeRunningCosts: sensitive(z.boolean(), 'cost'),
  /** A line or the total does not fit a cost amount: nothing is totalled. */
  tooLarge: sensitive(z.boolean(), 'cost'),
  /**
   * Why it is incomplete, one entry per thing missing that can be added (empty when complete). A
   * service's `no_recipe` alone is a hint: its materials are optional, and its cost is complete.
   */
  reasons: sensitive(z.array(incompleteReasonDto), 'cost'),
  /**
   * Nothing that can be added is missing, or only a service's optional materials (costCompleteFor,
   * D-203; `cost`: what is missing says what the cost is made of). A share awaiting sales is not
   * missing: see beforeRunningCosts (with a team and without materials it may be the only line, so
   * the total is null and nothing is missing).
   */
  complete: sensitive(z.boolean(), 'cost'),
})
export type UnitCostDto = z.infer<typeof unitCostDto>

/**
 * The margin on the price before VAT, worked out on what is known: while the cost is incomplete
 * (`cost.complete`, visible with it) or before running costs (`cost.beforeRunningCosts`) the real
 * margin is at most this.
 */
export const marginDto = z.object({
  /** Price before VAT − total (12 decimals; negative is a loss); null without a price or a total. */
  amount: sensitive(zDecimal.nullable(), 'profit_margin'),
  /** amount ÷ price before VAT × 100 (12 decimals); null with a price of 0 as well. */
  percent: sensitive(zDecimal.nullable(), 'profit_margin'),
})
export type MarginDto = z.infer<typeof marginDto>

/** The owner's time settings as they apply (D-119). */
export const ownerTimeSettingDto = z.object({
  /** A business without a team counts the owner's time. */
  applies: z.boolean(),
  /** businesses.owner_hourly_rate (null: not set). */
  hourlyRate: sensitive(zDecimal.nullable(), 'cost'),
})

// ---------------------------------------------------------------------------------------------------
// productCost.list: the Product costs page
// ---------------------------------------------------------------------------------------------------

/** A page of the list: search, which products, sorted by, a filter, where the page starts. */
export const productCostListInput = z
  .object({
    /** Part of the name, any case (empty: everything). */
    search: z.string().trim().max(CATALOG_SEARCH_MAX_LENGTH).optional(),
    /** `active` (default), `archived`, or `all`. */
    status: z.enum(['active', 'archived', 'all']).default('active'),
    /** Only products, or only services. */
    type: z.enum(PRODUCT_TYPES).optional(),
    /** `name` (default); `cost` needs costs visible; `margin`, `margin_percent` margins. */
    sort: z.enum(PRODUCT_COST_SORTS).default('name'),
    /**
     * `asc` (default) or `desc`. Not `direction`: tRPC's infinite queries put their own `direction`
     * (and `cursor`) in the input.
     */
    order: z.enum(['asc', 'desc']).default('asc'),
    /** `incomplete` needs costs visible; `loss` margins. */
    filter: z.enum(PRODUCT_COST_FILTERS).optional(),
    /** `nextCursor` of the previous page, as it came (with the same sort, order and filter). */
    cursor: z.string().min(1).max(200).optional(),
    limit: z.int().min(1).max(PRODUCT_COST_PAGE_SIZE_MAX).default(PRODUCT_COST_PAGE_SIZE),
  })
  .prefault({})
export type ProductCostListInput = z.input<typeof productCostListInput>

export const productCostRowDto = z.object({
  productId: zUuid,
  name: z.string(),
  type: z.enum(PRODUCT_TYPES),
  /** The unit it is sold by: the costs are for one of it. */
  unit: standardUnitDto,
  /** `recipe`: what its recipe uses; `resale`: bought ready to sell (D-117). */
  kind: productCostKindDto,
  archived: z.boolean(),
  /** How many of its unit the recipe makes (1 without a recipe and for an item bought ready to sell). */
  yieldQty: zDecimal,
  /** Recipe lines (0: no recipe yet; 1 for an item bought ready to sell). */
  lineCount: z.int().min(0),
  /** Lines whose material has no price yet. */
  unpricedLines: z.int().min(0),
  price: salePriceDto,
  cost: unitCostDto,
  margin: marginDto,
})
export type ProductCostRowDto = z.infer<typeof productCostRowDto>

/**
 * How many products of the list (its search, status and type; whatever the filter) need a look: the
 * page's filter shows them (`incomplete`: those not `complete`, the Dashboard's count too). `noTime`:
 * without a team, those with none of the owner's minutes.
 */
export const productCostCountsDto = z.object({
  all: z.int().min(0),
  incomplete: sensitive(z.int().min(0), 'cost'),
  loss: sensitive(z.int().min(0), 'profit_margin'),
  noTime: sensitive(z.int().min(0), 'cost'),
})

export const productCostListDto = withMeta(
  z.object({
    items: z.array(productCostRowDto),
    nextCursor: z.string().nullable(),
    counts: productCostCountsDto,
    /** The business currency (ISO 4217). */
    currency: z.string(),
    /** Today in the business's time zone: the day the costs are worked out for. */
    today: zBusinessDate,
    /** The days the materials' 90-day average covers (D-115). */
    averageFrom: zBusinessDate,
    /** How running costs reach what the business sells (the same for every product). */
    monthCosts: monthCostsDto,
    ownerTime: ownerTimeSettingDto,
  }),
)
export type ProductCostListDto = z.infer<typeof productCostListDto>

// ---------------------------------------------------------------------------------------------------
// productCost.get: one product's breakdown
// ---------------------------------------------------------------------------------------------------

export const productCostGetInput = z.object({ productId: zUuid })
export type ProductCostGetInput = z.input<typeof productCostGetInput>

/** One material line: what it uses, what it costs at the average, and the last purchase price. */
export const productCostLineDto = z.object({
  materialId: zUuid,
  materialName: z.string(),
  /** The unit the material is counted in (the prices are per one of it). */
  materialUnit: standardUnitDto,
  dimension: dimensionDto,
  materialArchived: z.boolean(),
  /** As the recipe says it (for an item bought ready to sell: 1 of the product's unit). */
  qty: zDecimal,
  unit: standardUnitDto.nullable(),
  packId: zUuid.nullable(),
  packName: z.string().nullable(),
  /** The same in the material's base unit. */
  baseQty: zDecimal,
  /** Null: never bought ("no price yet", never 0). */
  cost: z
    .object({
      /** Which average (D-115): the last 90 days of purchases, or the last purchase. */
      basis: averageBasisDto,
      /** The average per the material's unit (12 decimals). */
      perUnit: sensitive(zDecimal, 'cost'),
      /** The line (for the whole recipe): base quantity × average, divided once. */
      lineCost: sensitive(zDecimal, 'cost'),
    })
    .nullable(),
  /** Its last purchase still standing (D-115: shown beside the average). Null: never bought. */
  lastPurchase: z
    .object({
      purchaseId: zUuid,
      businessDate: zBusinessDate,
      /** What one of the material's unit cost on it (after discounts, with delivery). */
      pricePerUnit: sensitive(zDecimal, 'supplier_price'),
    })
    .nullable(),
})
export type ProductCostLineDto = z.infer<typeof productCostLineDto>

export const productCostBreakdownDto = withMeta(
  z.object({
    productId: zUuid,
    name: z.string(),
    type: z.enum(PRODUCT_TYPES),
    unit: standardUnitDto,
    kind: productCostKindDto,
    archived: z.boolean(),
    currency: z.string(),
    today: zBusinessDate,
    price: salePriceDto,
    /** Its materials (null: the Materials module is off). */
    materials: z
      .object({
        /** How many of the product's unit the recipe makes: the lines are for that many. */
        yieldQty: zDecimal,
        /** In the recipe's order (empty: no recipe yet). */
        lines: z.array(productCostLineDto),
        /** Σ the lines that have a price (the whole recipe); null when none has one. */
        total: sensitive(zDecimal.nullable(), 'cost'),
        /** One unit sold: total ÷ yield (null with the total, or too large). */
        perUnit: sensitive(zDecimal.nullable(), 'cost'),
        unpricedLines: z.int().min(0),
        /** The days the 90-day average covers. */
        averageFrom: zBusinessDate,
        averageTo: zBusinessDate,
      })
      .nullable(),
    cost: unitCostDto,
    margin: marginDto,
    monthCosts: monthCostsDto,
    ownerTime: ownerTimeSettingDto,
  }),
)
export type ProductCostBreakdownDto = z.infer<typeof productCostBreakdownDto>

// ---------------------------------------------------------------------------------------------------
// productCost.settings / updateSettings: how product costs are worked out
// ---------------------------------------------------------------------------------------------------

/** An amount: more than zero, numeric(20,4) (the currency's decimals are checked by the API). */
const positiveAmount = zDecimal.refine(
  (value) => checkDecimal(value, 'money') === null && compareDecimal(value, '0') > 0,
  { message: 'more than zero, with at most 4 decimals' },
)

export const productCostSettingsDto = withMeta(
  z.object({
    /** The owner's hourly rate (null: not set). Used only without a team (D-119). */
    ownerHourlyRate: sensitive(zDecimal.nullable(), 'cost'),
    /**
     * The business has a team: the owner's time is not counted (the rate is kept), and nothing is
     * left to set here (running costs need no setting, D-202).
     */
    hasTeam: z.boolean(),
    currency: z.string(),
  }),
)
export type ProductCostSettingsDto = z.infer<typeof productCostSettingsDto>

/**
 * `productCost.updateSettings`: the owner's hourly rate (null clears it). At most the currency's
 * decimals (VALIDATION). Only without a team (CAPABILITY_DISABLED).
 */
export const updateProductCostSettingsInput = z.object({
  ownerHourlyRate: positiveAmount.nullable(),
})
export type UpdateProductCostSettingsInput = z.input<typeof updateProductCostSettingsInput>
