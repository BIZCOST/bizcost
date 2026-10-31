import type { Percent } from '../numbers/kinds'

// Stock and Usage & Waste words the data, the API and the screens share (M4; D-339). Neutral by rule
// (PRODUCT.md §4 rule 5): usage nobody explained is "unexplained usage", never anyone's fault.

/** Why stock was used beyond what was sold, when someone records it as it happens (Q7). */
export const WASTE_REASONS = [
  'waste', // waste or spillage
  'damaged', // damaged or expired
  'staff_use',
  'complimentary', // free or complimentary
  'failed', // a failed piece or an offcut
  'customer_return', // returned by a customer and not back in stock (Q8)
  'other',
] as const
export type WasteReason = (typeof WASTE_REASONS)[number]

/**
 * Reasons given at a count's review for a loss (Q6): the waste reasons, and "the recipe needs
 * adjusting" (the recipe uses more than it says; it never changes the recipe by itself). What no
 * reason covers stays unexplained usage. A count mistake is no reason: the line is counted again.
 */
export const COUNT_REASONS = [...WASTE_REASONS, 'recipe'] as const
export type CountReason = (typeof COUNT_REASONS)[number]

/** The business's tolerance before usage is flagged, until it sets its own (Q10). */
export const DEFAULT_USAGE_TOLERANCE = '5' as Percent

/** How far a nested prepared item may go: a sauce in a dough in a dish (Q14). */
export const MAX_PREPARED_DEPTH = 3
