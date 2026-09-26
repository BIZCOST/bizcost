import { z } from 'zod'

// Dashboard (ROADMAP.md Step 7, docs/PRODUCT.md §10): in M1, the getting-started checklist, built
// from real data.

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

/** `dashboard.checklist`: the steps this member can act on in this business, with their state. */
export const dashboardChecklistDto = z.object({ items: z.array(checklistItemDto) })
export type DashboardChecklistDto = z.infer<typeof dashboardChecklistDto>
