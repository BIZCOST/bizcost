import {
  createRunningCostInput,
  okDto,
  removeRunningCostInput,
  runningCostIdInput,
  runningCostListDto,
  runningCostListInput,
  runningCostResultDto,
  updateRunningCostInput,
} from '@bizcost/contracts'
import {
  createRunningCost,
  getRunningCost,
  listRunningCosts,
  removeRunningCost,
  updateRunningCost,
} from '../services/running-costs'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Running costs (services/running-costs.ts; D-116): module `running_costs` (planned until M2 Step 7;
 * the dev-only preview reaches it before then, D-125), then running_costs.items.view to read and
 * .manage to add, change or remove one. Outputs are withMeta(): amounts are `cost` (D-165).
 */
const runningCostsModule = businessProcedure.use(requireModule('running_costs'))
const viewRunningCosts = runningCostsModule.use(requirePermission('running_costs.items.view'))
const manageRunningCosts = runningCostsModule.use(requirePermission('running_costs.items.manage'))

export const runningCostRouter = router({
  /** `runningCost.list`: by name, with the monthly total of those active today. */
  list: viewRunningCosts
    .input(runningCostListInput)
    .output(runningCostListDto)
    .query(({ ctx, input }) => listRunningCosts(ctx, input)),
  /** `runningCost.get`. */
  get: viewRunningCosts
    .input(runningCostIdInput)
    .output(runningCostResultDto)
    .query(({ ctx, input }) => getRunningCost(ctx, input)),
  /** `runningCost.create`: idempotent on the client's id. */
  create: manageRunningCosts
    .input(createRunningCostInput)
    .output(runningCostResultDto)
    .mutation(({ ctx, input }) => createRunningCost(ctx, input)),
  /** `runningCost.update`: the whole record, `version` as read. */
  update: manageRunningCosts
    .input(updateRunningCostInput)
    .output(runningCostResultDto)
    .mutation(({ ctx, input }) => updateRunningCost(ctx, input)),
  /** `runningCost.remove`: one entered by mistake (soft-deleted), `version` as read. */
  remove: manageRunningCosts
    .input(removeRunningCostInput)
    .output(okDto)
    .mutation(({ ctx, input }) => removeRunningCost(ctx, input)),
})
