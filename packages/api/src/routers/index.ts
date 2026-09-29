import { router } from '../trpc'
import { accountRouter } from './account'
import { attachmentRouter } from './attachment'
import { booksRouter } from './books'
import { businessRouter } from './business'
import { dashboardRouter } from './dashboard'
import { health } from './health'
import { invitationRouter } from './invitation'
import { locationRouter } from './location'
import { materialRouter } from './material'
import { me } from './me'
import { memberRouter } from './member'
import { productRouter } from './product'
import { purchaseRouter } from './purchase'
import { purchaseReturnRouter } from './purchase-return'
import { recipeRouter } from './recipe'
import { roleRouter } from './role'
import { supplierRouter } from './supplier'

/**
 * The API of M1 and of M2 so far. Routers of each module arrive with the module's build (no
 * placeholders); a planned module's procedures answer MODULE_DISABLED until it is released.
 */
export const appRouter = router({
  health,
  me,
  account: accountRouter,
  business: businessRouter,
  dashboard: dashboardRouter,
  location: locationRouter,
  member: memberRouter,
  invitation: invitationRouter,
  role: roleRouter,
  material: materialRouter,
  product: productRouter,
  recipe: recipeRouter,
  supplier: supplierRouter,
  purchase: purchaseRouter,
  purchaseReturn: purchaseReturnRouter,
  attachment: attachmentRouter,
  books: booksRouter,
})

export type AppRouter = typeof appRouter
