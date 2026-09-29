import { recipeGetInput, recipeResultDto, saveRecipeInput } from '@bizcost/contracts'
import { getRecipe, saveRecipe } from '../services/recipes'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Recipes (services/recipes.ts; M2 Step 4): what one unit of a product or service uses. Module
 * `products` and module `materials` (a recipe's lines are materials), each released and on for the
 * business (MODULE_DISABLED otherwise; both planned until M2 Step 7, so only the dev-only preview
 * reaches them before then, D-125), then materials.items.view (a recipe names its materials and shows
 * their averages; a role cannot hold products.recipes.view without it, PERMISSION_NEEDS, and this
 * holds for a member's own overrides too, D-155), products.recipes.view to read and
 * products.recipes.manage to write. Costs are `cost` (withMeta).
 */
const recipesModule = businessProcedure
  .use(requireModule('products'))
  .use(requireModule('materials'))
  .use(requirePermission('materials.items.view'))
const viewRecipes = recipesModule.use(requirePermission('products.recipes.view'))
const manageRecipes = recipesModule.use(requirePermission('products.recipes.manage'))

export const recipeRouter = router({
  /** `recipe.get`: the recipe of a product or service, with what each line and the whole cost. */
  get: viewRecipes
    .input(recipeGetInput)
    .output(recipeResultDto)
    .query(({ ctx, input }) => getRecipe(ctx, input)),
  /** `recipe.save`: the whole recipe, `version` as read (0 before its first save). */
  save: manageRecipes
    .input(saveRecipeInput)
    .output(recipeResultDto)
    .mutation(({ ctx, input }) => saveRecipe(ctx, input)),
})
