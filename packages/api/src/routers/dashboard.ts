import { dashboardCardsDto, dashboardChecklistDto } from '@bizcost/contracts'
import { getCards } from '../services/cards'
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
  /**
   * `dashboard.cards` (dashboard.home.view; M3 Step 3): the decision cards the business has data for
   * and this member may see (services/cards.ts); none while Sales is not served.
   */
  cards: viewDashboard.output(dashboardCardsDto).query(({ ctx }) => getCards(ctx)),
})
