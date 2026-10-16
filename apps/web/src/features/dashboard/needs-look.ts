import type { DashboardCardsDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import type { NavWording } from '@/components/shell/nav'

// "Needs a look" (D-247): the rows of the Dashboard card, in its order, and each row's words.

export type LookKind = keyof NonNullable<DashboardCardsDto['data']['needsLook']>

export const LOOK_KINDS = [
  'unpricedMaterials',
  'channelsWithoutFees',
  'productsWithoutRecipe',
  'materialsInNoRecipe',
] as const satisfies readonly LookKind[]

/**
 * A row's title, hint and button in the business's words (`wording`: businessWording in nav.ts): a
 * recipe is food wording, "items used" retail's and "materials used" everyone else's (PRODUCT.md §13,
 * D-146, D-156), and the button names the page as the nav does (D-282).
 */
export function lookWords(
  kind: LookKind,
  wording: NavWording,
): { readonly title: I18nKey; readonly hint: I18nKey; readonly action: I18nKey } {
  return {
    title: wording(`dashboard.cards.needsLook.${kind}`),
    hint: wording(`dashboard.cards.needsLook.${kind}Hint`),
    action: wording(`dashboard.cards.needsLook.actions.${kind}`),
  }
}
