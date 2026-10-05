import { SALE_SHARE_STATES } from '@bizcost/domain'
import { z } from 'zod'
import { withMeta } from '../envelope'
import { zBusinessDate } from '../primitives'
import { sensitive } from '../sensitivity'

// Dashboard (ROADMAP.md Step 7, docs/PRODUCT.md §10): the getting-started checklists, built from real
// data. "Finish setting up" (M1: the business's profile, TRN, team and branches) and, since the
// Costing Core's release (M2 Step 7), "Let's find the real cost of what you sell".

/**
 * The checklist's steps, in the order shown: complete the business profile, add the TRN, invite the
 * first team member, add a second branch. Which of them a member sees: `checklistItemIds` in
 * @bizcost/modules.
 */
export const CHECKLIST_ITEM_IDS = ['profile', 'trn', 'invite', 'location'] as const
export type ChecklistItemId = (typeof CHECKLIST_ITEM_IDS)[number]

/** Parts of a complete business profile (D-090): the name in Arabic and the logo. */
export const PROFILE_PARTS = ['arabicName', 'logo'] as const
export type ProfilePart = (typeof PROFILE_PARTS)[number]

export const checklistItemDto = z.object({
  id: z.enum(CHECKLIST_ITEM_IDS),
  done: z.boolean(),
  /** What the step still needs: the missing profile parts (empty for the other steps). */
  missing: z.array(z.enum(PROFILE_PARTS)),
})
export type ChecklistItemDto = z.infer<typeof checklistItemDto>

/**
 * "Let's find the real cost of what you sell" (PRODUCT.md §10, M2 Step 7), in the order shown: add
 * what you sell → what you use to make it → purchase prices → your regular running costs → your time
 * (without a team) → see your product costs; and, while Sales and Reports are served (M3 Step 3), it
 * becomes "Let's calculate your first real profit": → add or import your sales → see your real
 * profit. Which of them a member sees: `costStepIds` in @bizcost/modules (the modules on, the keys to
 * do it, and for the cost steps the costs visible).
 */
export const COST_STEP_IDS = [
  'products',
  'recipes',
  'purchases',
  'running_costs',
  'owner_time',
  'product_costs',
  'sales',
  'real_profit',
] as const
export type CostStepId = (typeof COST_STEP_IDS)[number]

/**
 * What a cost step still needs: running costs not entered yet (they are what is shared over what the
 * business sells, D-202), the owner's hourly rate, their minutes on any product or service.
 */
export const COST_STEP_PARTS = ['runningCosts', 'hourlyRate', 'minutes'] as const
export type CostStepPart = (typeof COST_STEP_PARTS)[number]

export const costStepDto = z.object({
  id: z.enum(COST_STEP_IDS),
  done: z.boolean(),
  missing: z.array(z.enum(COST_STEP_PARTS)),
  /**
   * How many are still left, where it counts them (null otherwise): products made here without what
   * goes into them (`recipes`), materials they use never bought (`purchases`), products and services
   * whose cost is incomplete (`product_costs`).
   */
  remaining: z.int().nonnegative().nullable(),
})
export type CostStepDto = z.infer<typeof costStepDto>

/** `dashboard.checklist`: the steps this member can act on in this business, with their state. */
export const dashboardChecklistDto = z.object({
  items: z.array(checklistItemDto),
  /** "Let's find the real cost of what you sell": empty when the member can act on none. */
  costSteps: z.array(costStepDto),
})
export type DashboardChecklistDto = z.infer<typeof dashboardChecklistDto>

// ---------------------------------------------------------------------------------------------------
// dashboard.cards: the decision cards (M3 Step 3, PRODUCT.md §9, Q14)
// ---------------------------------------------------------------------------------------------------
//
// Only the cards the business has data for and the member may see: a card is null otherwise (no
// placeholder), and every card is null while Sales is not served (a released business sees no change
// before Release A) or before the first finalized sale. Sales figures need every sale seen
// (sales.documents.view, H1); profit and every cost fact (a loss, cost increases, what needs a look,
// the parts of "where the money went") need `reports.profit.view` with what it needs (Q11). A member
// limited to some branches sees only their branches' sales, at the shares their sales carry (no
// business-level costs). Withheld in the service, and tagged: costs `cost`, profit `profit_margin`.
// Figures are unbounded decimal strings (D-209).

const cardAmount = z.string().regex(/^-?\d+(?:\.\d+)?$/)
const cardCost = () => sensitive(cardAmount.nullable(), 'cost')
const cardProfit = () => sensitive(cardAmount.nullable(), 'profit_margin')

/** A month's figure against the month before (the same days of it while this month runs). */
const versusDto = z.object({
  /** This month so far (its days from … to). */
  from: zBusinessDate,
  to: zBusinessDate,
  value: cardAmount,
  /** Last month, whole (null: nothing sold in it). */
  lastMonth: cardAmount.nullable(),
})

/** "Your real profit this month" against last month (business level; branches: their own). */
const profitCardDto = z.object({
  from: zBusinessDate,
  to: zBusinessDate,
  profit: cardProfit(),
  marginPercent: cardProfit(),
  lastMonthProfit: cardProfit(),
  lastMonthMarginPercent: cardProfit(),
  /** Some cost of the month is not known yet (reasons in Reports); before running costs. */
  complete: sensitive(z.boolean().nullable(), 'cost'),
  beforeRunningCosts: sensitive(z.boolean().nullable(), 'cost'),
  /** Something sold this month (the member's branches): without, the profit is the costs so far. */
  sold: z.boolean(),
  /**
   * The month's costs so far the profit takes off (business level, D-237), over `costsFrom` … `to`
   * (the 1st, or the first sale's day in a first month); null for a member limited to branches or
   * with both modules off. Said under the figure, since early in a month they can outweigh the sales
   * (D-250).
   */
  monthCosts: cardCost(),
  costsFrom: sensitive(zBusinessDate.nullable(), 'cost'),
})

/** "Where the money went" this month: each part of the sales before VAT. */
const moneyWentDto = z.object({
  sales: cardAmount,
  materials: cardCost(),
  fees: cardCost(),
  deliveryCost: cardCost(),
  /** The month's costs so far (business level) or the shares carried (a member limited to branches). */
  runningCosts: cardCost(),
  ownerTime: cardCost(),
  profit: cardProfit(),
})

/** One day of "Sales and real profit by day" (this month, the days so far). */
const dayDto = z.object({
  day: zBusinessDate,
  sales: cardAmount,
  /** The day's sales at the shares they carry (null: withheld). */
  profit: cardProfit(),
})

const productFigureDto = z.object({
  productId: z.string(),
  name: z.string(),
  unit: z.string(),
  quantity: cardAmount,
  sales: cardAmount,
  profit: cardProfit(),
  marginPercent: cardProfit(),
})

/** A product sold at a loss or a low real margin this month (Q14: under 10 %). */
const concernDto = z.object({
  productId: z.string(),
  name: z.string(),
  concern: sensitive(z.enum(['loss', 'low']).nullable(), 'profit_margin'),
  marginPercent: cardProfit(),
  sales: cardAmount,
})

/** A material in what sold whose average rose 10 % or more in 30 days (Q14). */
const costIncreaseDto = z.object({
  materialId: z.string(),
  name: z.string(),
  unit: z.string(),
  /** Its average per unit 30 days ago and now, and the rise in percent. */
  before: cardCost(),
  now: cardCost(),
  percent: cardCost(),
})

const channelFigureDto = z.object({
  channelId: z.string(),
  name: z.string(),
  kind: z.string(),
  sales: cardAmount,
  profit: cardProfit(),
  marginPercent: cardProfit(),
})

const namedDto = z.object({ id: z.string(), name: z.string() })

/** "Needs a look" (cost facts): what keeps real profit from being complete or honest. */
const needsLookDto = z.object({
  /** Materials behind finalized sales (of the member's branches) that have no price yet. */
  unpricedMaterials: z.array(namedDto),
  /** Channels that sold this month and keep a part of each sale, with no %, statement or fees expense. */
  channelsWithoutFees: z.array(namedDto),
  /** Products that sold this month without a recipe while Materials is on. */
  productsWithoutRecipe: z.array(namedDto),
  /** Materials bought in the last 90 days that no product or service uses (Q13: shared as costs). */
  materialsInNoRecipe: z.array(namedDto),
})

export const dashboardCardsDto = withMeta(
  z.object({
    currency: z.string(),
    today: zBusinessDate,
    /** This month (YYYY-MM) and the month before. */
    month: z.string(),
    lastMonth: z.string(),
    /** The member sees profit (reports.profit.view with what it needs). */
    profitShown: z.boolean(),
    profit: profitCardDto.nullable(),
    sales: versusDto.nullable(),
    moneyWent: moneyWentDto.nullable(),
    byDay: z
      .object({
        days: z.array(dayDto),
        /**
         * The rate this month's days carry (SALE_SHARE_STATES; null: withheld): `applied` or `none`
         * each day carries its share; `before_running_costs` none yet (it shows on `showsOn`), so
         * the days are before running costs while the month's profit takes off its costs so far.
         */
        rateState: sensitive(z.enum(SALE_SHARE_STATES).nullable(), 'cost'),
        showsOn: sensitive(zBusinessDate.nullable(), 'cost'),
      })
      .nullable(),
    topProducts: z
      .object({
        /** The most sold this month, by quantity. */
        byQuantity: z.array(productFigureDto),
        /** The best real margin % this month (null: withheld). */
        byMargin: sensitive(z.array(productFigureDto).nullable(), 'profit_margin'),
      })
      .nullable(),
    concerns: sensitive(z.array(concernDto).nullable(), 'profit_margin'),
    costIncreases: sensitive(z.array(costIncreaseDto).nullable(), 'cost'),
    /** With two or more channels that sold this month. */
    byChannel: z.array(channelFigureDto).nullable(),
    needsLook: sensitive(needsLookDto.nullable(), 'cost'),
  }),
)
export type DashboardCardsDto = z.infer<typeof dashboardCardsDto>
