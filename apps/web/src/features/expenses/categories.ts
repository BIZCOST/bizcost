import { nameKey } from '@bizcost/domain'

// The categories expenses and running costs share (M2 Step 5; D-116, D-167), in the order people look
// for them: the owner's starter list in its own order (rent, electricity, water, salaries…), then the
// business's own categories (by name, as the API lists them), and "Other" last. The starter
// categories are plain data once made (renamed, archived, added to), so a category is matched by its
// name as people read it; one renamed since sorts with the business's own.

/**
 * `categories` in the order above. `starterNames`: the starter names in the page's language
 * (setup.cost_categories.<key>), in the order of STARTER_COST_CATEGORIES, whose last is "Other".
 */
export function orderCategories<T extends { readonly name: string }>(
  categories: readonly T[],
  starterNames: readonly string[],
): T[] {
  const starters = starterNames.map((name) => nameKey(name))
  const other = starters.length - 1
  const rank = (category: T): number => {
    const index = starters.indexOf(nameKey(category.name))
    if (index === -1) return other - 0.5
    return index === other ? starters.length : index
  }
  // A stable sort: the business's own keep the API's order (by name).
  return categories
    .map((category, index) => ({ category, index, rank: rank(category) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ category }) => category)
}

/**
 * The categories a picker offers: the active ones, and the one the record already has (an archived
 * category stays on what has it, D-167).
 */
export function pickableCategories<
  T extends { readonly id: string; readonly archivedAt: string | null },
>(categories: readonly T[], current: string): T[] {
  return categories.filter((category) => category.archivedAt === null || category.id === current)
}
