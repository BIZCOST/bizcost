import { profitSummaryDto, profitSummaryInput } from '@bizcost/contracts'
import { profitSummary } from '../services/reports'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Reports → Real profit (services/reports.ts; M3 Step 3): module `reports` (planned until Release A,
 * so served only under the dev-only preview, D-125) and `reports.sales.view` (the sales figures, which
 * need every sale seen). Profit and what it is made of only with `reports.profit.view` (the service
 * withholds them otherwise). Outputs are withMeta(): costs and profit are removed for members without
 * the costs switch.
 */
const viewReports = businessProcedure
  .use(requireModule('reports'))
  .use(requirePermission('reports.sales.view'))

export const profitRouter = router({
  /**
   * `profit.summary`: real profit of a period (a month, or from–to within 12 months), grouped by
   * month, week (Monday to Sunday), day, product, channel or branch, with each month's rate and the
   * business-level line.
   */
  summary: viewReports
    .input(profitSummaryInput)
    .output(profitSummaryDto)
    .query(({ ctx, input }) => profitSummary(ctx, input)),
})
