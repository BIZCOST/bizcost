import {
  checkDecimal,
  compareDecimal,
  INCOMPLETE_REASONS,
  PRODUCT_TYPES,
  PURCHASE_MONTHS,
  RUNNING_SHARE_STATES,
} from '@bizcost/domain'
import { z } from 'zod'
import { CATALOG_SEARCH_MAX_LENGTH } from '../catalog'
import { withMeta } from '../envelope'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
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

// Product costs (ROADMAP.md M2 Step 6; D-115, D-116, D-119, D-121, D-178): what one unit sold of each
// product or service costs, line by line, and its margin, worked out on read (nothing stored):
//   - materials: its recipe at the materials' averages ÷ what the recipe makes, or, bought ready to
//     sell, its material's average;
//   - running costs: a share of the material cost, materials × monthly running costs ÷ monthly
//     material purchases (the last 3 full months of purchases, or the owner's estimate until they
//     count), with the numbers it was worked out from, so the screen can say it in words ("your
//     running costs are AED 15,000 a month and you buy about AED 30,000 of materials a month, so each
//     dirham of materials carries 0.50");
//   - the owner's time, for a business without a team: minutes × hourly rate ÷ 60;
//   - the total (their exact sum), the price before VAT, and the margin on it (amount and %).
// Never rounded here (12 decimals; screens round). Nothing missing is ever 0: its value is null and
// `reasons` says why, so the screen says it plainly and marks the total incomplete.
//
// Sensitive: costs, what they are made of and why they are incomplete are `cost`; monthly purchases
// are `supplier_price`; margins `profit_margin`. The three are visible only together (D-144, D-187:
// price − cost is the margin). Outputs are withMeta() envelopes. Sorting or filtering on a hidden
// value is FORBIDDEN (the API checks it before anything is read). The business's monthly running
// costs and material purchases behind the rate are shown only to a member who may see running costs
// and purchases (D-186); others get the rate alone.

/** Why a product's cost is incomplete (INCOMPLETE_REASONS in @bizcost/domain). */
export const incompleteReasonDto = z.enum(INCOMPLETE_REASONS)

/**
 * The running-cost line of a product: `off` (Running Costs off), `not_entered` (none ever entered:
 * incomplete, never 0), `none` (nothing paid to run the business now: 0), `no_materials` (Materials
 * off, or a service without materials: a known limit of this method until working time comes in
 * Phase 5), `not_set` (neither an estimate nor 3 full months of purchases), `no_recipe` (a product
 * without its recipe yet), `waiting` (its materials have no price yet), `applied`.
 */
export const runningShareStateDto = z.enum(RUNNING_SHARE_STATES)

/** The owner's time line: `team` (none with a team), `none` (no minutes), `rate_not_set`, `applied`. */
export const ownerTimeStateDto = z.enum(['team', 'none', 'rate_not_set', 'applied'])

/**
 * How the business's running costs reach its products (D-116), in numbers the screen says in words:
 * `off` (Running Costs off), `not_entered` (none ever entered), `none` (no running cost paid today),
 * `not_set` (running costs, and neither the owner's estimate nor 3 full months of purchases),
 * `ready` (the rate is known).
 */
export const runningCostRateDto = z.object({
  state: sensitive(z.enum(['off', 'not_entered', 'none', 'not_set', 'ready']), 'cost'),
  /**
   * The monthly running costs and material purchases below are shown: the member may see running
   * costs and purchases (running_costs.items.view and purchases.documents.view). Otherwise they are
   * null and only the rate is given (D-186): it is no more than any product's share ÷ its materials.
   */
  totalsShown: z.boolean(),
  /** The running costs paid today, a month (each turned into a monthly amount); null when off. */
  monthlyRunningCosts: sensitive(zDecimal.nullable(), 'cost'),
  purchases: z.object({
    /** Which figure the rate divides by: the last 3 full months, the owner's estimate, or none. */
    source: sensitive(z.enum(['last_3_months', 'estimate']).nullable(), 'supplier_price'),
    /** That figure, a month (null: none). */
    monthly: sensitive(zDecimal.nullable(), 'supplier_price'),
    /** The last 3 full calendar months: their first and last day. */
    from: zBusinessDate,
    to: zBusinessDate,
    /** Their average a month once they count (null before; it may be 0). */
    average: sensitive(zDecimal.nullable(), 'supplier_price'),
    /** The owner's estimate of materials bought a month (null: not set). */
    estimate: sensitive(zDecimal.nullable(), 'supplier_price'),
    /**
     * The first day on which the 3 months can count: 3 full months after the month of the first
     * posted purchase (null: nothing bought yet). Until then the estimate is used.
     */
    countsFrom: zBusinessDate.nullable(),
    /** How many of the 3 months hold a posted purchase: they count only when all 3 do (D-186). */
    monthsBought: z.int().min(0).max(PURCHASE_MONTHS),
    /** They count today (from countsFrom, each of the 3 months holding a purchase). */
    ready: z.boolean(),
  }),
  /**
   * Monthly running costs ÷ monthly purchases (12 decimals): what each unit of currency of materials
   * carries. 0 with no running costs; null when off or not set.
   */
  rate: sensitive(zDecimal.nullable(), 'cost'),
})
export type RunningCostRateDto = z.infer<typeof runningCostRateDto>

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
    /** materials × running costs ÷ purchases; 0 with no running costs; null otherwise. */
    share: sensitive(zDecimal.nullable(), 'cost'),
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
  /** A line or the total does not fit a cost amount: nothing is totalled. */
  tooLarge: sensitive(z.boolean(), 'cost'),
  /** Why it is incomplete, one entry per thing missing (empty when complete). */
  reasons: sensitive(z.array(incompleteReasonDto), 'cost'),
  /** Every line that applies is worked out (`cost`: what is missing says what the cost is made of). */
  complete: sensitive(z.boolean(), 'cost'),
})
export type UnitCostDto = z.infer<typeof unitCostDto>

/**
 * The margin on the price before VAT, worked out on what is known: while the cost is incomplete
 * (`cost.complete`, visible with it) the real margin is at most this.
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
 * page's filter shows them. `noTime`: without a team, those with none of the owner's minutes.
 */
export const productCostCountsDto = z.object({
  all: z.int().min(0),
  incomplete: sensitive(z.int().min(0), 'cost'),
  loss: sensitive(z.int().min(0), 'profit_margin'),
  noTime: sensitive(z.int().min(0), 'cost'),
  /**
   * Of the incomplete ones, services without materials missing only what they cannot carry yet: running
   * costs, with this method, and their optional materials (awaitsServiceShare, D-200).
   */
  servicesAwaitingShare: sensitive(z.int().min(0), 'cost'),
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
    /** How running costs reach products (the same for every product). */
    rate: runningCostRateDto,
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
    rate: runningCostRateDto,
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
    /** The owner's estimate of materials bought a month (null: not set). */
    estimatedMonthlyPurchases: sensitive(zDecimal.nullable(), 'supplier_price'),
    /** The owner's hourly rate (null: not set). Used only without a team. */
    ownerHourlyRate: sensitive(zDecimal.nullable(), 'cost'),
    /** The business has a team: the owner's time is not counted (the rate is kept). */
    hasTeam: z.boolean(),
    currency: z.string(),
    /** Today in the business's time zone (when the 3 months of purchases can count is said from it). */
    today: zBusinessDate,
    /** How running costs reach products now, with the estimate or the purchases. */
    rate: runningCostRateDto,
  }),
)
export type ProductCostSettingsDto = z.infer<typeof productCostSettingsDto>

/**
 * `productCost.updateSettings`: each field given is saved (null clears it), each left out is kept; at
 * least one. At most the currency's decimals (VALIDATION). The hourly rate only without a team
 * (CAPABILITY_DISABLED).
 */
export const updateProductCostSettingsInput = z
  .object({
    estimatedMonthlyPurchases: positiveAmount.nullable().optional(),
    ownerHourlyRate: positiveAmount.nullable().optional(),
  })
  .refine(
    (input) => input.estimatedMonthlyPurchases !== undefined || input.ownerHourlyRate !== undefined,
    { message: 'nothing to save' },
  )
export type UpdateProductCostSettingsInput = z.input<typeof updateProductCostSettingsInput>
