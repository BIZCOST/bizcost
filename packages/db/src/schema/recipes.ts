import { STANDARD_UNITS, type StandardUnit } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, tenantTable } from './_helpers'
import { materials, materialUnits, productsServices } from './catalog'

// Recipes (M2 Step 4; docs/DATA_MODEL.md §6, D-146): ONE structure for a recipe (food), a bill of
// materials (makers, workshops, factories) and "what you use" (services); only the wording changes
// with the terminology profile. A recipe is what it takes to make `yield_qty` units of a product or
// service (its `unit`; 1 by default, e.g. a cake recipe that makes 12 slices, D-178): materials,
// packaging included, each in any unit or pack of the material (a unit of another dimension through
// its cross factor). Material cost is never typed here: it comes from purchases (the material's
// average, D-115), computed on read; one unit sold costs the recipe's total ÷ its yield. An item
// bought ready to sell has no recipe (D-117).

const STANDARD_UNIT_LIST = sql.raw(
  Object.keys(STANDARD_UNITS)
    .map((unit) => `'${unit}'`)
    .join(', '),
)

const quantity = (name: string) => numeric(name, { precision: 24, scale: 6 })

/**
 * The recipe of a product or service: at most one per product, made at its first save. Its
 * `version` is the recipe's (a save names the version it read: CONFLICT otherwise), apart from the
 * product's, so editing the price and the recipe never collide. `yield_qty` is how many of the
 * product's unit the recipe makes (more than zero; 1 by default, when the lines are what one unit
 * uses), saved, versioned and audited with the recipe (D-178).
 */
export const recipes = tenantTable(
  'recipes',
  {
    productId: uuid('product_id').notNull(),
    yieldQty: quantity('yield_qty').notNull().default('1'),
  },
  (t) => [
    tenantRef('recipes_product_fk', [t.businessId, t.productId], productsServices),
    unique('recipes_product_key').on(t.businessId, t.productId),
    check('recipes_yield_qty_check', sql`yield_qty > 0`),
  ],
)

/**
 * A line of a recipe: a material and how much of it the whole recipe uses (for its yield), as typed (`qty` in `unit`, a
 * standard unit, or in `pack_id`, one of the material's packs), and `base_qty`, the same in the
 * material's base unit (g, ml, piece…), worked out by the units engine when the line is saved and
 * again whenever the material's units change (the API refuses a change that would leave a line
 * without a conversion). One live line per material. Lines taken out are soft-deleted.
 */
export const recipeLines = tenantTable(
  'recipe_lines',
  {
    recipeId: uuid('recipe_id').notNull(),
    position: integer('position').notNull(),
    materialId: uuid('material_id').notNull(),
    qty: quantity('qty').notNull(),
    unit: text('unit').$type<StandardUnit>(),
    packId: uuid('pack_id'),
    baseQty: quantity('base_qty').notNull(),
  },
  (t) => [
    tenantRef('recipe_lines_recipe_fk', [t.businessId, t.recipeId], recipes),
    tenantRef('recipe_lines_material_fk', [t.businessId, t.materialId], materials),
    // A pack of the line's own material only.
    foreignKey({
      name: 'recipe_lines_pack_fk',
      columns: [t.businessId, t.materialId, t.packId],
      foreignColumns: [materialUnits.businessId, materialUnits.materialId, materialUnits.id],
    }),
    // One live line per material in a recipe.
    uniqueIndex('recipe_lines_material_key')
      .on(t.businessId, t.recipeId, t.materialId)
      .where(sql`deleted_at is null`),
    // The recipes that use a material (its units changed; is it in use?).
    index('recipe_lines_material_idx').on(t.businessId, t.materialId),
    check('recipe_lines_unit_check', sql`num_nonnulls(unit, pack_id) = 1`),
    check('recipe_lines_unit_code_check', sql`unit in (${STANDARD_UNIT_LIST})`),
    check('recipe_lines_position_check', sql`position >= 0`),
    check('recipe_lines_qty_check', sql`qty > 0`),
    check('recipe_lines_base_qty_check', sql`base_qty > 0`),
  ],
)

export type Recipe = typeof recipes.$inferSelect
export type NewRecipe = typeof recipes.$inferInsert
export type RecipeLine = typeof recipeLines.$inferSelect
export type NewRecipeLine = typeof recipeLines.$inferInsert
