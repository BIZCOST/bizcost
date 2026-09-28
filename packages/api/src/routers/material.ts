import {
  catalogIdInput,
  catalogListInput,
  createMaterialInput,
  materialDto,
  materialCostsDto,
  materialCostsInput,
  materialListDto,
  updateMaterialInput,
} from '@bizcost/contracts'
import { materialCosts } from '../services/material-costs'
import {
  archiveMaterial,
  createMaterial,
  getMaterial,
  listMaterials,
  unarchiveMaterial,
  updateMaterial,
} from '../services/materials'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Materials (services/materials.ts): module `materials` (released and on for the business, else
 * MODULE_DISABLED; planned until M2 Step 7, so only the dev-only preview reaches it before then,
 * D-125), then materials.items.view to read and materials.items.manage to write.
 */
const materialsModule = businessProcedure.use(requireModule('materials'))
const viewMaterials = materialsModule.use(requirePermission('materials.items.view'))
const manageMaterials = materialsModule.use(requirePermission('materials.items.manage'))

export const materialRouter = router({
  /** `material.list`: a page by name, with search and a status filter (active by default). */
  list: viewMaterials
    .input(catalogListInput)
    .output(materialListDto)
    .query(({ ctx, input }) => listMaterials(ctx, input)),
  /** `material.get`: one material with its packs and cross factors. */
  get: viewMaterials
    .input(catalogIdInput)
    .output(materialDto)
    .query(({ ctx, input }) => getMaterial(ctx, input)),
  /**
   * `material.costs`: the average each material's cost uses today (the 90-day purchase average until
   * the first stock count, D-115) and its last purchase price. Averages are `cost`, prices
   * `supplier_price` (withMeta).
   */
  costs: viewMaterials
    .input(materialCostsInput)
    .output(materialCostsDto)
    .query(({ ctx, input }) => materialCosts(ctx, input)),
  /** `material.create`: idempotent on the client's id; units checked by the domain engine. */
  create: manageMaterials
    .input(createMaterialInput)
    .output(materialDto)
    .mutation(({ ctx, input }) => createMaterial(ctx, input)),
  /** `material.update`: the whole material with its units, `version` as read. */
  update: manageMaterials
    .input(updateMaterialInput)
    .output(materialDto)
    .mutation(({ ctx, input }) => updateMaterial(ctx, input)),
  /** `material.archive`: never a delete. */
  archive: manageMaterials
    .input(catalogIdInput)
    .output(materialDto)
    .mutation(({ ctx, input }) => archiveMaterial(ctx, input)),
  /** `material.unarchive`. */
  unarchive: manageMaterials
    .input(catalogIdInput)
    .output(materialDto)
    .mutation(({ ctx, input }) => unarchiveMaterial(ctx, input)),
})
