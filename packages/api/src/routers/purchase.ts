import {
  correctPurchaseInput,
  createPurchaseInput,
  documentIdInput,
  documentVersionInput,
  okDto,
  purchaseListDto,
  purchaseListInput,
  purchasePayersDto,
  purchaseResultDto,
  updatePurchaseInput,
} from '@bizcost/contracts'
import { listPayers } from '../services/purchase-payments'
import {
  correctPurchase,
  createPurchase,
  discardPurchase,
  getPurchase,
  listPurchases,
  postPurchase,
  reversePurchase,
  updatePurchase,
} from '../services/purchases'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Purchases (services/purchases.ts): module `purchases` (planned until M2 Step 7; the dev-only
 * preview reaches it before then, D-125), then purchases.documents.view to read, .manage for drafts,
 * .post to post, .reverse to reverse, and .reverse with .manage to correct. Outputs are withMeta(): supplier prices are
 * removed for members without data.supplier_price.view.
 */
export const purchasesModule = businessProcedure.use(requireModule('purchases'))
export const viewPurchases = purchasesModule.use(requirePermission('purchases.documents.view'))
export const managePurchases = purchasesModule.use(requirePermission('purchases.documents.manage'))
export const postPurchases = purchasesModule.use(requirePermission('purchases.documents.post'))
export const reversePurchases = purchasesModule.use(
  requirePermission('purchases.documents.reverse'),
)

export const purchaseRouter = router({
  /** `purchase.list`: newest business day first, filters and a cursor. */
  list: viewPurchases
    .input(purchaseListInput)
    .output(purchaseListDto)
    .query(({ ctx, input }) => listPurchases(ctx, input)),
  /** `purchase.get`: with its lines, returns and credit notes. */
  get: viewPurchases
    .input(documentIdInput)
    .output(purchaseResultDto)
    .query(({ ctx, input }) => getPurchase(ctx, input)),
  /**
   * `purchase.payers`: the active members a purchase may say paid from their own money (the caller
   * is picked until someone else is).
   */
  payers: managePurchases.output(purchasePayersDto).query(({ ctx }) => listPayers(ctx)),
  /** `purchase.create`: a draft, idempotent on the client's id. */
  create: managePurchases
    .input(createPurchaseInput)
    .output(purchaseResultDto)
    .mutation(({ ctx, input }) => createPurchase(ctx, input)),
  /** `purchase.update`: the whole draft, `version` as read. */
  update: managePurchases
    .input(updatePurchaseInput)
    .output(purchaseResultDto)
    .mutation(({ ctx, input }) => updatePurchase(ctx, input)),
  /** `purchase.discard`: a draft is taken out; a posted purchase never is. */
  discard: managePurchases
    .input(documentVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardPurchase(ctx, input)),
  /** `purchase.post`: the goods come into stock and the average moves. Idempotent. */
  post: postPurchases
    .input(documentVersionInput)
    .output(purchaseResultDto)
    .mutation(({ ctx, input }) => postPurchase(ctx, input)),
  /** `purchase.reverse`: as if never posted. Idempotent. */
  reverse: reversePurchases
    .input(documentIdInput)
    .output(purchaseResultDto)
    .mutation(({ ctx, input }) => reversePurchase(ctx, input)),
  /**
   * `purchase.correct`: reverse, and a copy as a new draft (`newId`). Idempotent on `newId`. It
   * reverses and opens a draft, so it needs .reverse and .manage.
   */
  correct: reversePurchases
    .use(requirePermission('purchases.documents.manage'))
    .input(correctPurchaseInput)
    .output(purchaseResultDto)
    .mutation(({ ctx, input }) => correctPurchase(ctx, input)),
})
