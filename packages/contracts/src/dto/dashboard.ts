import { z } from 'zod'

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
 * (without a team) → see your product costs. Which of them a member sees: `costStepIds` in
 * @bizcost/modules (the modules on, the keys to do it, and for the last two the costs visible).
 */
export const COST_STEP_IDS = [
  'products',
  'recipes',
  'purchases',
  'running_costs',
  'owner_time',
  'product_costs',
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
