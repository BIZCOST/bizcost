import { router } from '../trpc'
import { accountRouter } from './account'
import { attachmentRouter } from './attachment'
import { booksRouter } from './books'
import { businessRouter } from './business'
import { costCategoryRouter } from './cost-category'
import { dashboardRouter } from './dashboard'
import { expensePaymentRouter, expenseRouter } from './expense'
import { health } from './health'
import { invitationRouter } from './invitation'
import { locationRouter } from './location'
import { materialRouter } from './material'
import { me } from './me'
import { memberRouter } from './member'
import { payableRouter, purchasePaymentRouter } from './payable'
import { productRouter } from './product'
import { productCostRouter } from './product-cost'
import { purchaseRouter } from './purchase'
import { purchaseReturnRouter } from './purchase-return'
import { recipeRouter } from './recipe'
import { roleRouter } from './role'
import { runningCostRouter } from './running-cost'
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
  purchasePayment: purchasePaymentRouter,
  payable: payableRouter,
  attachment: attachmentRouter,
  books: booksRouter,
  costCategory: costCategoryRouter,
  expense: expenseRouter,
  expensePayment: expensePaymentRouter,
  runningCost: runningCostRouter,
  productCost: productCostRouter,
})

export type AppRouter = typeof appRouter
