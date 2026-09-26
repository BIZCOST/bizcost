import { dashboardChecklistDto } from '@bizcost/contracts'
import { getChecklist } from '../services/dashboard'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

const viewDashboard = businessProcedure
  .use(requireModule('dashboard'))
  .use(requirePermission('dashboard.home.view'))

export const dashboardRouter = router({
  /**
   * `dashboard.checklist` (dashboard.home.view): the getting-started steps this member can act on in
   * this business (by capability and permission), each done or not from the business's data
   * (services/dashboard.ts).
   */
  checklist: viewDashboard.output(dashboardChecklistDto).query(({ ctx }) => getChecklist(ctx)),
})
